pragma ever-solidity ^0.62.0;



import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IGravixAccount.sol";
import "../../interfaces/IOracleProxy.sol";
import "./GravixVaultMarkets.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";
import "locklift/src/console.sol";



abstract contract GravixVaultOrders is GravixVaultMarkets {
    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER REQUEST HANDLERS -------------------------------
    // ----------------------------------------------------------------------------------
    function _handleMarketOrderRequest(
        address user, uint128 collateral, TvmCell order_params_payload, Callback.CallMeta meta
    ) internal view returns (bool success) {
        (
            uint32 market_idx,
            PositionType position_type,
            uint32 leverage,
            uint128 expected_price,
            uint32 max_slippage_rate
        ) = decodeMarketOrderRequestPayload(order_params_payload);

        if (!validateOrderRequestParams(market_idx, leverage, max_slippage_rate)) return false;
        if (checkPositionAllowed(
            market_idx,
            collateral,
            leverage,
            expected_price,
            position_type) > 0
        ) return false;
        if (!marketOpen(market_idx)) return false;
        _marketOrderRequest(user, market_idx, position_type, collateral, leverage, expected_price, max_slippage_rate, meta);
        return true;
    }

    function validateOrderRequestParams(uint32 market_idx, uint32 leverage, uint32 max_slippage) public view returns (bool correct) {
        if (!markets.exists(market_idx)) return false;
        if (leverage > markets[market_idx].maxLeverage) return false;
        if (max_slippage > HUNDRED_PERCENT) return false;
        return true;
    }

    function _marketOrderRequest(
        address user,
        uint32 market_idx,
        PositionType position_type,
        uint128 collateral,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage_rate, // %
        Callback.CallMeta meta
    ) internal view {
        Market _market = markets[market_idx];

        PendingMarketOrderRequest new_request = PendingMarketOrderRequest(
            user,
            market_idx,
            position_type,
            collateral,
            expected_price,
            leverage,
            max_slippage_rate,
            _market.fees.openFeeRate,
            _market.fees.closeFeeRate,
            _market.fees.baseSpreadRate,
            liquidationThresholdRate,
            _market.fees.borrowBaseRatePerHour,
            meta
        );

        address vex_acc = getGravixAccountAddress(user);
        IGravixAccount(vex_acc).process_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(new_request);
    }

    function finish_requestMarketOrder(
        PendingMarketOrderRequest request,
        uint32 request_key
    ) external override onlyGravixAccount(request.user) reserve {
        collateralReserve += request.collateral;

        emit MarketOrderRequest(
            request.meta.call_id,
            request.user,
            request.marketIdx,
            request.positionType,
            request.collateral,
            request.expectedPrice,
            request.leverage,
            request.maxSlippageRate,
            request_key
        );

        _sendOpenOrderOracleRequest(
            request.user,
            request_key,
            request.marketIdx,
            request.collateral,
            request.leverage,
            request.positionType,
            request.meta
        );
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- ORACLE REQUEST ---------------------------------------
    // ----------------------------------------------------------------------------------
    function _sendOpenOrderOracleRequest(
        address user,
        uint32 request_key,
        uint32 market_idx,
        uint128 collateral,
        uint32 leverage,
        PositionType position_type,
        Callback.CallMeta meta
    ) internal view {
        address proxy = _deployOracleProxy(market_idx, 0, meta);
        IOracleProxy(proxy).setExecuteCallback{value: 0.1 ever}(user, request_key, collateral, leverage, position_type);
    }

    function _sendCloseOrderOracleRequest(
        address user,
        uint32 position_key,
        uint32 market_idx,
        Callback.CallMeta meta
    ) internal view {
        address proxy = _deployOracleProxy(market_idx, 0, meta);
        IOracleProxy(proxy).setCloseCallback{value: 0.1 ever}(user, position_key);
    }

    function _sendLiquidationOracleRequest(
        address liquidator,
        uint32 market_idx,
        PositionIdx[] positions,
        Callback.CallMeta meta
    ) internal view {
        // TODO: calculate deploy gas value
        address proxy = _deployOracleProxy(market_idx, Gas.ORACLE_PROXY_DEPLOY, meta);
        uint128 callback_value = uint128(positions.length) * Gas.LIQUIDATION_VALUE;
        IOracleProxy(proxy).setLiquidationCallback{value: callback_value, flag: MsgFlag.SENDER_PAYS_FEES}(liquidator, positions);
    }

    function _deployOracleProxy(uint32 market_idx, uint128 deploy_value, Callback.CallMeta meta) internal view returns (address) {
        OracleType price_source = markets[market_idx].priceSource;
        Oracle oracle = oracles[market_idx];

        emit OraclePriceRequested(meta.call_id, market_idx);
        return new OracleProxy{
            stateInit: _buildOracleProxyInitData(tx.timestamp),
            value: deploy_value,
            flag: deploy_value == 0 ? MsgFlag.ALL_NOT_RESERVED : MsgFlag.SENDER_PAYS_FEES
        }(
            usdt, market_idx, price_source, oracle, meta
        );
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER EXECUTE HANDLERS -------------------------------
    // ----------------------------------------------------------------------------------
    function oracle_executeMarketOrder(
        uint64 nonce,
        address user,
        uint32 request_key,
        uint32 market_idx,
        uint128 collateral,
        uint32 leverage,
        PositionType position_type,
        uint128 asset_price,
        Callback.CallMeta meta
    ) external override onlyOracleProxy(nonce) reserve {
        uint128 position_size_asset = calculatePositionAssetSize(collateral, leverage, asset_price);
        uint64 dynamic_spread = getDynamicSpread(position_size_asset, market_idx, position_type);

        uint16 _error = _addPositionToMarketOrReturnErr(market_idx, position_size_asset, asset_price, position_type);

        address vex_acc = getGravixAccountAddress(user);
        if (_error == 0) {
            (int256 accLongUSDFundingPerShare, int256 accShortUSDFundingPerShare) = _updateFunding(market_idx, asset_price);
            int256 funding = position_type == PositionType.Long ? accLongUSDFundingPerShare : accShortUSDFundingPerShare;

            IGravixAccount(vex_acc).process_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                request_key,
                market_idx,
                position_size_asset,
                position_type,
                asset_price,
                dynamic_spread,
                funding,
                meta
            );
        } else {
            // order cant be executed now, some limits reached and etc.
            IGravixAccount(vex_acc).process_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(request_key, meta);
        }
    }

    function revert_executeMarketOrder(
        address user,
        uint32 request_key,
        uint32 market_idx,
        uint128 collateral,
        uint128 position_size_asset,
        uint128 asset_price,
        PositionType position_type,
        Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        emit MarketOrderExecutionRevert(meta.call_id, user, request_key);

        _removePositionFromMarket(market_idx, position_size_asset, asset_price, position_type);

        // too high slippage
        if (collateral > 0) {
            collateralReserve -= collateral;
            _transfer(
                usdtWallet, collateral, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED
            );
        } else {
            // tried to execute non-existent order
            _sendCallbackOrGas(user, meta.nonce, false, meta.send_gas_to);
        }
    }

    function finish_executeMarketOrder(
        address user,
        uint32 request_key,
        IGravixAccount.Position new_pos,
        Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserveAndSuccessCallback(meta) {
        _collectOpenFee(new_pos.openFee);
        collateralReserve -= new_pos.openFee;

        uint128 position_size_asset_raw = calculatePositionAssetSize(new_pos.initialCollateral, new_pos.leverage, new_pos.markPrice);
        _removePositionFromMarket(new_pos.marketIdx, position_size_asset_raw, new_pos.markPrice, new_pos.positionType);

        uint128 position_size_asset = calculatePositionAssetSize(new_pos.initialCollateral - new_pos.openFee, new_pos.leverage, new_pos.openPrice);
        _addPositionToMarket(new_pos.marketIdx, position_size_asset, new_pos.markPrice, new_pos.positionType);

        emit MarketOrderExecution(
            meta.call_id,
            user,
            new_pos.positionType,
            new_pos.openPrice,
            new_pos.openFee,
            request_key
        );
    }

    function calculatePositionAssetSize(uint128 collateral, uint32 leverage, uint128 asset_price) public pure returns (uint128 position_size_asset) {
        return math.muldiv(math.muldiv(collateral, leverage, LEVERAGE_BASE), USDT_DECIMALS, asset_price);
    }

    function getDynamicSpread(
        uint128 position_size_asset,
        uint32 market_idx,
        PositionType position_type
    ) public view responsible returns (uint64 dynamic_spread) {
        uint128 new_noi;

        Market market = markets[market_idx];
        // calculate dynamic dynamic_spread multiplier
        if (position_type == PositionType.Long) {
            uint128 new_longs_total = market.totalLongsAsset + position_size_asset / 2;
            new_noi = new_longs_total - math.min(market.totalShortsAsset, new_longs_total);
        } else {
            uint128 new_shorts_total = market.totalShortsAsset + position_size_asset / 2;
            new_noi = new_shorts_total - math.min(market.totalShortsAsset, new_shorts_total);
        }
        dynamic_spread = uint64(math.muldiv(new_noi, market.fees.baseDynamicSpreadRate, market.depthAsset));
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } dynamic_spread;
    }
    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER CANCEL HANDLERS --------------------------------
    // ----------------------------------------------------------------------------------
    function cancelMarketOrder(address user, uint32 request_key, Callback.CallMeta meta) external view onlyActive reserve {
        require (msg.value >= Gas.MIN_MSG_VALUE, Errors.LOW_MSG_VALUE);

        address vex_acc = getGravixAccountAddress(user);
        IGravixAccount(vex_acc).process_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(request_key, meta);
    }

    function revert_cancelMarketOrder(
        address user, uint32 request_key, Callback.CallMeta meta
    ) external view override onlyGravixAccount(user) reserveAndFailCallback(meta) {
        emit CancelMarketOrderRevert(meta.call_id, user, request_key);
    }

    function finish_cancelMarketOrder(
        address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        collateralReserve -= collateral;

        emit CancelMarketOrder(meta.call_id, user, request_key);
        _transfer(usdtWallet, collateral, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED);
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER CLOSE HANDLERS ---------------------------------
    // ----------------------------------------------------------------------------------
    // TODO: chainlink oracle data
    function forceClosePositions(
        address[] users, uint32[] position_keys, Callback.CallMeta meta
    ) external view onlyOwner reserve {
        require (users.length == position_keys.length, Errors.BAD_INPUT);
        require (msg.value >= Gas.MIN_MSG_VALUE * users.length, Errors.LOW_MSG_VALUE);

        for (uint i = 0; i < users.length; i++) {
            address vex_acc = getGravixAccountAddress(users[i]);
            IGravixAccount(vex_acc).process_closePosition{value: Gas.MIN_MSG_VALUE - 0.1 ever}(
                position_keys[i], meta
            );
        }
    }

    // TODO: chainlink oracle data
    function closePosition(uint32 position_key, Callback.CallMeta meta) external view onlyActive reserve {
        require (msg.value >= Gas.MIN_MSG_VALUE, Errors.LOW_MSG_VALUE);

        address vex_acc = getGravixAccountAddress(msg.sender);
        IGravixAccount(vex_acc).process_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            position_key, meta
        );
    }

    function process1_closePosition(
        address user, uint32 position_key, uint32 market_idx, Callback.CallMeta meta
    ) external view override reserve {
        // soft fail
        if (!marketOpen(market_idx)) {
            emit ClosePositionRevert(meta.call_id, user, position_key);
            _sendCallbackOrGas(user, meta.nonce, false, meta.send_gas_to);
            return;
        }

        _sendCloseOrderOracleRequest(user, position_key, market_idx, meta);
    }

    function oracle_closePosition(
        uint64 nonce,
        address user,
        uint32 position_key,
        uint32 market_idx,
        uint128 asset_price,
        Callback.CallMeta meta
    ) external override onlyOracleProxy(nonce) reserve {
        (int256 accLongUSDFundingPerShare, int256 accShortUSDFundingPerShare) = _updateFunding(market_idx, asset_price);

        address vex_acc = getGravixAccountAddress(user);
        IGravixAccount(vex_acc).process2_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            position_key,
            asset_price,
            accLongUSDFundingPerShare,
            accShortUSDFundingPerShare,
            meta
        );
    }

    function revert_closePosition(
        address user, uint32 position_key, Callback.CallMeta meta
    ) external view override onlyGravixAccount(user) reserveAndFailCallback(meta) {
        emit ClosePositionRevert(meta.call_id, user, position_key);
    }

    function finish_closePosition(
        address user, uint32 position_key, uint128 asset_price, IGravixAccount.PositionView position_view, Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        // we already deducted open fee when position was opened
        uint128 collateral = position_view.position.initialCollateral - position_view.position.openFee;
        collateralReserve -= collateral;

        uint128 initial_position_size_asset = calculatePositionAssetSize(collateral, position_view.position.leverage, position_view.position.openPrice);
        _removePositionFromMarket(
            position_view.position.marketIdx,
            initial_position_size_asset,
            asset_price,
            position_view.position.positionType
        );

        if (position_view.liquidate) {
            _increaseInsuranceFund(collateral);

            emit LiquidatePosition(meta.call_id, user, user, position_key, position_view);
            _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
        } else {
            int256 pnl_with_fees = position_view.pnl - position_view.borrowFee - position_view.fundingFee;
            _collectCloseFee(position_view.closeFee);

            if (pnl_with_fees < 0) _increaseInsuranceFund(uint128(math.abs(pnl_with_fees)));
            if (pnl_with_fees > 0) _decreaseInsuranceFund(uint128(pnl_with_fees));

            emit ClosePosition(meta.call_id, user, position_key, position_view);

            // we know for sure collateral > pnl and fee, otherwise position would have been liquidated
            uint128 user_net_usdt = uint128(collateral + pnl_with_fees - position_view.closeFee);
            _transfer(usdtWallet, user_net_usdt, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED);
        }
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- LIQUIDATION ------------------------------------------
    // ----------------------------------------------------------------------------------
    // @notice 1.5 ever for every market + 1.5 ever for every position
    // @dev Aggregate by market to minimize requests to oracle
    function liquidatePositions(mapping (uint32 => PositionIdx[]) liquidations, Callback.CallMeta meta) external view reserve {
        // dont spend gas to check msg.value, it will fail with 37 code anyway if user didnt send enough, because we use exact values here
        for ((uint32 market_idx, PositionIdx[] positions) : liquidations) {
            _sendLiquidationOracleRequest(msg.sender, market_idx, positions, meta);
        }
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function revert_liquidatePositions(
        address user, address liquidator, uint32 position_key, Callback.CallMeta meta
    ) external view override onlyGravixAccount(user) reserveAndFailCallback(meta) {
        emit LiquidatePositionRevert(meta.call_id, liquidator, user, position_key);
    }

    function oracle_liquidatePositions(
        uint64 nonce, address liquidator, uint32 market_idx, PositionIdx[] positions, uint128 asset_price, Callback.CallMeta meta
    ) external override onlyOracleProxy(nonce) reserve {
        (int256 accLongUSDFundingPerShare, int256 accShortUSDFundingPerShare) = _updateFunding(market_idx, asset_price);

        for (PositionIdx position: positions) {
            address vex_acc = getGravixAccountAddress(position.user);
            // reserve 0.05 ever here to cover computation costs of this txn
            IGravixAccount(vex_acc).process_liquidatePositions{value: Gas.LIQUIDATION_VALUE - 0.05 ever}(
                liquidator,
                position.positionKey,
                asset_price,
                accLongUSDFundingPerShare,
                accShortUSDFundingPerShare,
                meta
            );
        }
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function finish_liquidatePositions(
        address user,
        address liquidator,
        uint32 position_key,
        uint128 asset_price,
        IGravixAccount.PositionView position_view,
        Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        // we already deducted open fee when position was opened
        uint128 collateral = position_view.position.initialCollateral - position_view.position.openFee;
        collateralReserve -= collateral;

        // we added exactly this amount when opened order
        uint128 initial_position_size_asset = calculatePositionAssetSize(collateral, position_view.position.leverage, position_view.position.openPrice);
        _removePositionFromMarket(
            position_view.position.marketIdx,
            initial_position_size_asset,
            asset_price,
            position_view.position.positionType
        );

        uint128 liquidator_reward = math.muldiv(collateral, liquidatorRewardShare, HUNDRED_PERCENT);

        _increaseInsuranceFund(collateral - liquidator_reward);

        emit LiquidatePosition(meta.call_id, user, liquidator, position_key, position_view);

        _transfer(usdtWallet, liquidator_reward, liquidator, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.SENDER_PAYS_FEES);
        _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- POSITION LIMITS --------------------------------------
    // ----------------------------------------------------------------------------------
    function checkPositionAllowed(
        uint32 market_idx,
        uint128 collateral,
        uint32 leverage,
        uint128 asset_price,
        PositionType position_type
    ) public view returns (uint16) {
        uint128 position_size_asset = calculatePositionAssetSize(collateral, leverage, asset_price);
        (,,uint16 _error) = _calculatePositionImpactAndCheckAllowed(market_idx, position_size_asset, asset_price, position_type);
        return _error;
    }

    function _marketNOI(Market _market) internal pure returns (uint128) {
        return _market.totalLongsAsset > _market.totalShortsAsset ?
            _market.totalLongsAsset - _market.totalShortsAsset :
            _market.totalShortsAsset - _market.totalLongsAsset;
    }

    // @dev Will not apply changes if _error > 0
    function _addPositionToMarketOrReturnErr(
        uint32 market_idx, uint128 position_size_asset, uint128 cur_asset_price, PositionType position_type
    ) internal returns (uint16) {
        (
            Market _market,
            uint128 _totalNOI,
            uint16 _error
        ) = _calculatePositionImpactAndCheckAllowed(market_idx, position_size_asset, cur_asset_price, position_type);
        if (_error == 0) {
            markets[market_idx] = _market;
            totalNOI = _totalNOI;
        }
        return _error;
    }

    function _calculatePositionImpactAndCheckAllowed(
        uint32 market_idx,
        uint128 position_size_asset,
        uint128 cur_asset_price,
        PositionType position_type
    ) internal view returns (Market _market, uint128 _totalNOI, uint16 _error) {
        (_market, _totalNOI) = _calculatePositionImpact(market_idx, position_size_asset, cur_asset_price, position_type, false);

        uint128 shorts_usd = math.muldiv(_market.totalShortsAsset, cur_asset_price, USDT_DECIMALS);
        uint128 longs_usd = math.muldiv(_market.totalLongsAsset, cur_asset_price, USDT_DECIMALS);
        // market limits
        if (shorts_usd > _market.maxTotalShortsUSD || longs_usd > _market.maxTotalLongsUSD) _error = Errors.MARKET_POSITIONS_LIMIT_REACHED;
        // common platform limit
        if (math.muldiv(poolBalance, maxPoolUtilRatio, HUNDRED_PERCENT) < _totalNOI) _error = Errors.PLATFORM_POSITIONS_LIMIT_REACHED;
        return (_market, _totalNOI, _error);
    }

    // @param asset_price - asset price on moment of update, required for TNOI calculation
    function _calculatePositionImpact(
        uint32 market_idx, uint128 position_size_asset, uint128 cur_asset_price, PositionType position_type, bool remove
    ) internal view returns (Market _market, uint128 _totalNOI) {
        _market = markets[market_idx];
        _totalNOI = totalNOI;

        uint128 noi_asset_before = _marketNOI(_market);
        uint128 noi_usd_before = math.muldiv(noi_asset_before, _market.lastNoiUpdatePrice, USDT_DECIMALS);

        if (position_type == PositionType.Long) {
            _market.totalLongsAsset = remove ? (_market.totalLongsAsset - position_size_asset) : (_market.totalLongsAsset + position_size_asset);
        } else {
            _market.totalShortsAsset = remove ? (_market.totalShortsAsset - position_size_asset) : (_market.totalShortsAsset + position_size_asset);
        }

        uint128 noi_asset_after = _marketNOI(_market);
        uint128 noi_usd_after = math.muldiv(noi_asset_after, cur_asset_price, USDT_DECIMALS);

        _totalNOI -= math.muldiv(noi_usd_before, _market.noiWeight, WEIGHT_BASE);
        _totalNOI += math.muldiv(noi_usd_after, _market.noiWeight, WEIGHT_BASE);

        _market.lastNoiUpdatePrice = cur_asset_price;
    }


    // @param cur_asset_price - asset price on moment of update, required for TNOI calculation
    function _addPositionToMarket(uint32 market_idx, uint128 position_size_asset, uint128 cur_asset_price, PositionType position_type) internal {
        (
            markets[market_idx],
            totalNOI
        ) = _calculatePositionImpact(market_idx, position_size_asset, cur_asset_price, position_type, false);
    }

    // @param cur_asset_price - asset price on moment of update, required for TNOI calculation
    function _removePositionFromMarket(uint32 market_idx, uint128 position_size_asset, uint128 cur_asset_price, PositionType position_type) internal {
        (
            markets[market_idx],
            totalNOI
        ) = _calculatePositionImpact(market_idx, position_size_asset, cur_asset_price, position_type, true);
    }
    // ----------------------------------------------------------------------------------
    // --------------------------- FUNDINGS ---------------------------------------------
    // ----------------------------------------------------------------------------------
    function _updateFunding(uint32 market_idx, uint128 asset_price) internal returns (int256 accLongUSDFundingPerShare, int256 accShortUSDFundingPerShare) {
        Market _market = markets[market_idx];
        if (_market.lastFundingUpdateTime == 0) _market.lastFundingUpdateTime = now;

        (_market.accLongUSDFundingPerShare, _market.accShortUSDFundingPerShare) = _getUpdatedFunding(_market, asset_price);
        _market.lastFundingUpdateTime = now;

        markets[market_idx] = _market;
        return (_market.accLongUSDFundingPerShare, _market.accShortUSDFundingPerShare);
    }

    function getUpdatedFunding(uint32[] market_idx, uint128[] assets_prices) public view returns (int256[] accLongUSDFundingPerShare, int256[] accShortUSDFundingPerShare) {
        accLongUSDFundingPerShare = new int256[](market_idx.length);
        accShortUSDFundingPerShare = new int256[](market_idx.length);
        for (uint i = 0; i < market_idx.length; i++) {
            (accLongUSDFundingPerShare[i], accShortUSDFundingPerShare[i]) = _getUpdatedFunding(markets[market_idx[i]], assets_prices[i]);
        }
    }

    function _getUpdatedFunding(Market _market, uint128 asset_price) internal pure returns (int256 accLongUSDFundingPerShare, int256 accShortUSDFundingPerShare) {
        if (_market.lastFundingUpdateTime == 0) _market.lastFundingUpdateTime = now;
        (int128 long_rate_per_hour, int128 short_rate_per_hour) = _getFundingRates(_market);

        accLongUSDFundingPerShare = _market.accLongUSDFundingPerShare + _calculateFunding(long_rate_per_hour, _market.totalLongsAsset, asset_price, _market.lastFundingUpdateTime);
        accShortUSDFundingPerShare = _market.accShortUSDFundingPerShare + _calculateFunding(short_rate_per_hour, _market.totalShortsAsset, asset_price, _market.lastFundingUpdateTime);
    }

    function _calculateFunding(int128 rate_per_hour, uint128 total_position, uint128 asset_price, uint32 last_update_time) internal pure returns (int256) {
        if (rate_per_hour == 0 || total_position == 0) return 0;
        int256 funding_asset = math.muldiv(rate_per_hour, int256(total_position), HUNDRED_PERCENT);
        funding_asset = math.muldiv(funding_asset, (now - last_update_time), HOUR);
        int256 funding_usd = math.muldiv(funding_asset, asset_price, USDT_DECIMALS);
        return math.muldiv(funding_usd, SCALING_FACTOR, total_position);
    }

    // @notice returned rates are multiplied by 10**12, e.g 100% = 1_000_000_000_000
    function getFundingRates(uint32 market_idx) public view returns (int128 long_rate_per_hour, int128 short_rate_per_hour) {
        return _getFundingRates(markets[market_idx]);
    }

    // @notice If rate is positive - trader should pay, negative - receive payment
    function _getFundingRates(Market _market) internal pure returns (int128 long_rate_per_hour, int128 short_rate_per_hour) {
        uint128 noi = uint128(math.abs(int256(_market.totalLongsAsset) - _market.totalShortsAsset));
        uint128 funding_rate_per_hour = math.muldiv(
            _market.fees.fundingBaseRatePerHour,
            math.muldiv(noi, SCALING_FACTOR, _market.depthAsset),
            SCALING_FACTOR
        );

        if (_market.totalLongsAsset >= _market.totalShortsAsset) {
            long_rate_per_hour = int128(funding_rate_per_hour);
            if (_market.totalShortsAsset > 0) {
                short_rate_per_hour = -1 * int128(math.muldiv(funding_rate_per_hour, _market.totalLongsAsset, _market.totalShortsAsset));
            }
        } else {
            short_rate_per_hour = int128(funding_rate_per_hour);
            if (_market.totalLongsAsset > 0) {
                long_rate_per_hour = -1 * int128(math.muldiv(funding_rate_per_hour, _market.totalShortsAsset, _market.totalLongsAsset));
            }
        }
    }
}
