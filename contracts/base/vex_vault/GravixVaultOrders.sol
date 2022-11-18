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
        if (checkPositionAllowed(market_idx, math.muldiv(collateral, leverage, LEVERAGE_BASE), position_type) > 0) return false;
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
        uint128 position_size = math.muldiv(collateral, leverage, LEVERAGE_BASE);
        uint64 dynamic_spread = getDynamicSpread(position_size, market_idx, position_type);

        uint16 _error = _addPositionToMarketOrReturnErr(market_idx, position_size, position_type);

        address vex_acc = getGravixAccountAddress(user);
        if (_error == 0) {
            (int256 accLongFundingPerShare, int256 accShortFundingPerShare) = _updateFunding(market_idx);
            int256 funding = position_type == PositionType.Long ? accLongFundingPerShare : accShortFundingPerShare;

            IGravixAccount(vex_acc).process_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                request_key,
                market_idx,
                position_size,
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
        uint128 position_size,
        PositionType position_type,
        Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        emit MarketOrderExecutionRevert(meta.call_id, user, request_key);

        _removePositionFromMarket(market_idx, position_size, position_type);

        if (collateral > 0) {
            collateralReserve -= collateral;
            // too high slippage
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
        IGravixAccount.Position opened_position,
        Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserveAndSuccessCallback(meta) {
        _collectOpenFee(opened_position.openFee);
        collateralReserve -= opened_position.openFee;

        uint128 position_size = math.muldiv(
            opened_position.initialCollateral - opened_position.openFee,
            opened_position.leverage,
            LEVERAGE_BASE
        );

        emit MarketOrderExecution(
            meta.call_id,
            user,
            position_size,
            opened_position.positionType,
            opened_position.openPrice,
            opened_position.openFee,
            request_key
        );
    }

    function getDynamicSpread(
        uint128 position_size,
        uint32 market_idx,
        PositionType position_type
    ) public view responsible returns (uint64 dynamic_spread) {
        uint128 new_noi;

        Market market = markets[market_idx];
        // calculate dynamic dynamic_spread multiplier
        if (position_type == PositionType.Long) {
            uint128 new_longs_total = market.totalLongs + position_size / 2;
            new_noi = new_longs_total - math.min(market.totalShorts, new_longs_total);
        } else {
            uint128 new_shorts_total = market.totalShorts + position_size / 2;
            new_noi = new_shorts_total - math.min(market.totalShorts, new_shorts_total);
        }
        dynamic_spread = uint64(math.muldiv(new_noi, market.fees.baseDynamicSpreadRate, market.depth));
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
    function closePosition(address user, uint32 position_key, Callback.CallMeta meta) external view onlyActive reserve {
        require (msg.value >= Gas.MIN_MSG_VALUE, Errors.LOW_MSG_VALUE);

        address vex_acc = getGravixAccountAddress(user);
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
        (int256 accLongFundingPerShare, int256 accShortFundingPerShare) = _updateFunding(market_idx);

        address vex_acc = getGravixAccountAddress(user);
        IGravixAccount(vex_acc).process2_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            position_key,
            asset_price,
            accLongFundingPerShare,
            accShortFundingPerShare,
            meta
        );
    }

    function revert_closePosition(
        address user, uint32 position_key, Callback.CallMeta meta
    ) external view override onlyGravixAccount(user) reserveAndFailCallback(meta) {
        emit ClosePositionRevert(meta.call_id, user, position_key);
    }

    function finish_closePosition(
        address user, uint32 position_key, IGravixAccount.PositionView position_view, Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        // we already deducted open fee when position was opened
        uint128 collateral = position_view.initialCollateral - position_view.openFee;
        collateralReserve -= collateral;

        // we added exactly this amount when opened order
        uint128 initial_position_size = math.muldiv(position_view.initialCollateral, position_view.leverage, LEVERAGE_BASE);
        _removePositionFromMarket(position_view.marketIdx, initial_position_size, position_view.positionType);

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
        (int256 accLongFundingPerShare, int256 accShortFundingPerShare) = _updateFunding(market_idx);

        for (PositionIdx position: positions) {
            address vex_acc = getGravixAccountAddress(position.user);
            // reserve 0.05 ever here to cover computation costs of this txn
            IGravixAccount(vex_acc).process_liquidatePositions{value: Gas.LIQUIDATION_VALUE - 0.05 ever}(
                liquidator,
                position.positionKey,
                asset_price,
                accLongFundingPerShare,
                accShortFundingPerShare,
                meta
            );
        }
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function finish_liquidatePositions(
        address user, address liquidator, uint32 position_key, IGravixAccount.PositionView position_view, Callback.CallMeta meta
    ) external override onlyGravixAccount(user) reserve {
        // we already deducted open fee when position was opened
        uint128 collateral = position_view.initialCollateral - position_view.openFee;
        collateralReserve -= collateral;

        // we added exactly this amount when opened order
        uint128 initial_position_size = math.muldiv(position_view.initialCollateral, position_view.leverage, LEVERAGE_BASE);
        _removePositionFromMarket(position_view.marketIdx, initial_position_size, position_view.positionType);

        // TODO: send part to liquidator
        liquidator = user;

        _increaseInsuranceFund(collateral);

        emit LiquidatePosition(meta.call_id, user, user, position_key, position_view);
        _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- POSITION LIMITS --------------------------------------
    // ----------------------------------------------------------------------------------
    function checkPositionAllowed(uint32 market_idx, uint128 position_size, PositionType position_type) public view returns (uint16) {
        (,,,,uint16 _error) = _calculatePositionImpactAndCheckAllowed(market_idx, position_size, position_type);
        return _error;
    }

    function _marketNOI(Market _market) internal pure returns (uint128) {
        return _market.totalLongs > _market.totalShorts ?
            _market.totalLongs - _market.totalShorts :
            _market.totalShorts - _market.totalLongs;
    }

    // @dev Will not apply changes if _error > 0
    function _addPositionToMarketOrReturnErr(
        uint32 market_idx, uint128 position_size, PositionType position_type
    ) internal returns (uint16) {
        (
            Market _market,
            uint128 _totalLongs,
            uint128 _totalShorts,
            uint128 _totalNOI,
            uint16 _error
        ) = _calculatePositionImpactAndCheckAllowed(market_idx, position_size, position_type);
        if (_error == 0) {
            markets[market_idx] = _market;
            totalLongs = _totalLongs;
            totalShorts = _totalShorts;
            totalNOI = _totalNOI;
        }
        return _error;
    }

    function _calculatePositionImpactAndCheckAllowed(
        uint32 market_idx, uint128 position_size, PositionType position_type
    ) internal view returns (Market _market, uint128 _totalLongs, uint128 _totalShorts, uint128 _totalNOI, uint16 _error) {
        (
            _market,
            _totalLongs,
            _totalShorts,
            _totalNOI
        ) = _calculatePositionImpact(market_idx, position_size, position_type);
        // market limits
        if (_market.totalShorts > _market.maxTotalShorts || _market.totalLongs > _market.maxTotalLongs) _error = Errors.MARKET_POSITIONS_LIMIT_REACHED;
        // common platform limit
        if (math.muldiv(_totalNOI, SCALING_FACTOR, poolBalance) >= SCALING_FACTOR) _error = Errors.PLATFORM_POSITIONS_LIMIT_REACHED;
        return (_market, _totalLongs, _totalShorts, _totalNOI, _error);
    }

    function _calculatePositionImpact(
        uint32 market_idx, uint128 position_size, PositionType position_type
    ) internal view returns (Market _market, uint128 _totalLongs, uint128 _totalShorts, uint128 _totalNOI) {
        _market = markets[market_idx];
        _totalLongs = totalLongs;
        _totalShorts = totalShorts;
        _totalNOI = totalNOI;

        uint128 noi_before = _marketNOI(_market);

        if (position_type == PositionType.Long) {
            _market.totalLongs += position_size;
            _totalLongs += position_size;
        } else {
            _market.totalShorts += position_size;
            _totalShorts += position_size;
        }

        uint128 noi_after = _marketNOI(_market);

        if (noi_after > noi_before) _totalNOI += math.muldiv(noi_after - noi_before, _market.noiWeight, WEIGHT_BASE);
        if (noi_after < noi_before) _totalNOI -= math.muldiv(noi_before - noi_after, _market.noiWeight, WEIGHT_BASE);
    }

    function _removePositionFromMarket(uint32 market_idx, uint128 position_size, PositionType position_type) internal {
        Market _market = markets[market_idx];

        uint128 noi_before = _marketNOI(_market);

        if (position_type == PositionType.Long) {
            _market.totalLongs -= position_size;
            totalLongs -= position_size;
        } else {
            _market.totalShorts -= position_size;
            totalShorts -= position_size;
        }

        uint128 noi_after = _marketNOI(_market);

        if (noi_after > noi_before) totalNOI += math.muldiv(noi_after - noi_before, _market.noiWeight, WEIGHT_BASE);
        if (noi_after < noi_before) totalNOI -= math.muldiv(noi_before - noi_after, _market.noiWeight, WEIGHT_BASE);

        markets[market_idx] = _market;
    }
    // ----------------------------------------------------------------------------------
    // --------------------------- FUNDINGS ---------------------------------------------
    // ----------------------------------------------------------------------------------
    function _updateFunding(uint32 market_idx) internal returns (int256 accLongFundingPerShare, int256 accShortFundingPerShare) {
        Market _market = markets[market_idx];
        if (_market.lastFundingUpdateTime == 0) _market.lastFundingUpdateTime = now;

        (_market.accLongFundingPerShare, _market.accShortFundingPerShare) = _getUpdatedFunding(_market);
        _market.lastFundingUpdateTime = now;

        markets[market_idx] = _market;
        return (_market.accLongFundingPerShare, _market.accShortFundingPerShare);
    }

    function getUpdatedFunding(uint32[] market_idx) public view returns (int256[] accLongFundingPerShare, int256[] accShortFundingPerShare) {
        accLongFundingPerShare = new int256[](market_idx.length);
        accShortFundingPerShare = new int256[](market_idx.length);
        for (uint i = 0; i < market_idx.length; i++) {
            (accLongFundingPerShare[i], accShortFundingPerShare[i]) = _getUpdatedFunding(markets[market_idx[i]]);
        }
    }

    function _getUpdatedFunding(Market _market) internal pure returns (int256 accLongFundingPerShare, int256 accShortFundingPerShare) {
        if (_market.lastFundingUpdateTime == 0) _market.lastFundingUpdateTime = now;
        (int128 long_rate_per_hour, int128 short_rate_per_hour) = _getFundingRates(_market);

        accLongFundingPerShare = _market.accLongFundingPerShare + _calculateFunding(long_rate_per_hour, _market.totalLongs, _market.lastFundingUpdateTime);
        accShortFundingPerShare = _market.accShortFundingPerShare + _calculateFunding(short_rate_per_hour, _market.totalShorts, _market.lastFundingUpdateTime);
    }

    function _calculateFunding(int128 rate_per_hour, uint128 total_position, uint32 last_update_time) internal pure returns (int256) {
        if (rate_per_hour == 0 || total_position == 0) return 0;
        int256 funding = math.muldiv(rate_per_hour, int256(total_position), HUNDRED_PERCENT);
        funding = math.muldiv(funding, (now - last_update_time), HOUR);
        return math.muldiv(funding, SCALING_FACTOR, total_position);
    }

    // @notice returned rates are multiplied by 10**12, e.g 100% = 1_000_000_000_000
    function getFundingRates(uint32 market_idx) public view returns (int128 long_rate_per_hour, int128 short_rate_per_hour) {
        return _getFundingRates(markets[market_idx]);
    }

    // @notice If rate is positive - trader should pay, negative - receive payment
    function _getFundingRates(Market _market) internal pure returns (int128 long_rate_per_hour, int128 short_rate_per_hour) {
        uint128 noi = uint128(math.abs(int256(_market.totalLongs) - _market.totalShorts));
        uint128 funding_rate_per_hour = math.muldiv(
            _market.fees.fundingBaseRatePerHour,
            math.muldiv(noi, SCALING_FACTOR, _market.depth),
            SCALING_FACTOR
        );

        if (_market.totalLongs >= _market.totalShorts) {
            long_rate_per_hour = int128(funding_rate_per_hour);
            if (_market.totalShorts > 0) {
                short_rate_per_hour = -1 * int128(math.muldiv(funding_rate_per_hour, _market.totalLongs, _market.totalShorts));
            }
        } else {
            short_rate_per_hour = int128(funding_rate_per_hour);
            if (_market.totalLongs > 0) {
                long_rate_per_hour = -1 * int128(math.muldiv(funding_rate_per_hour, _market.totalShorts, _market.totalLongs));
            }
        }
    }
}
