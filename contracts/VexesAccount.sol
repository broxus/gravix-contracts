pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/vex_account/VexesAccountHelpers.sol";
import "./interfaces/IVexesVault.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";


contract VexesAccount is VexesAccountHelpers {
    // Cant be deployed directly
    constructor() public { revert(); }


    function onDeployRetry(TvmCell, TvmCell, address sendGasTo) external view onlyVexesVault functionID(0x23dc4360){
        tvm.rawReserve(_reserve(), 0);
        sendGasTo.transfer({ value: 0, bounce: false, flag: MsgFlag.ALL_NOT_RESERVED });
    }

    function process_requestMarketOrder(uint32 request_nonce, IVexesVault.PendingMarketOrderRequest pending_request) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        _nonce += 1;
        marketOrderRequests[_nonce] = MarketOrderRequest(
            pending_request.marketIdx,
            pending_request.positionType,
            pending_request.collateral,
            pending_request.expectedPrice,
            pending_request.leverage,
            pending_request.maxSlippageRate,
            pending_request.openFeeRate,
            pending_request.closeFeeRate,
            pending_request.baseSpreadRate,
            pending_request.liquidationThresholdRate,
            pending_request.borrowBaseRatePerHour
        );

        IVexesVault(vault).finish_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_nonce, user, _nonce, pending_request.meta
        );
    }

    function process_executeMarketOrder(
        uint32 request_key,
        uint market_idx,
        uint128 position_size,
        IVexesVault.PositionType position_type,
        uint128 asset_price,
        uint64 dynamic_spread,
        int256 accFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        MarketOrderRequest request = marketOrderRequests[request_key];
        uint128 leveraged_position = math.muldiv(request.collateral, request.leverage, LEVERAGE_BASE);

        // TODO: recheck what we got from oracle?
        if (
            !marketOrderRequests.exists(request_key) ||
            request.marketIdx != market_idx ||
            request.positionType != position_type ||
            position_size != leveraged_position
        ) {
            IVexesVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, market_idx, 0, position_size, position_type, meta
            );
            return;
        }

        delete marketOrderRequests[request_key];

        uint128 allowed_delta = math.muldiv(request.expectedPrice, request.maxSlippageRate, HUNDRED_PERCENT);
        uint128 min_price = request.expectedPrice - allowed_delta;
        uint128 max_price = request.expectedPrice + allowed_delta;

        // add base + dynamic spread
        uint128 open_price = applyOpenSpread(asset_price, request.positionType, request.baseSpreadRate + dynamic_spread);

        if (open_price < min_price || open_price > max_price) {
            IVexesVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, market_idx, request.collateral, position_size, position_type, meta
            );
            return;
        }

        uint128 open_fee = math.muldiv(leveraged_position, request.openFeeRate, HUNDRED_PERCENT);
        leveraged_position = math.muldiv(request.collateral - open_fee, request.leverage, LEVERAGE_BASE);

        Position opened_position = Position(
            request.marketIdx,
            request.positionType,
            request.collateral,
            open_fee,
            open_price,
            request.leverage,
            accFundingPerShare,
            request.borrowBaseRatePerHour,
            request.baseSpreadRate,
            request.closeFeeRate,
            request.liquidationThresholdRate,
            now
        );
        positions[request_key] = opened_position;

        IVexesVault(vault).finish_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, opened_position,  meta
        );
    }

    function process_cancelMarketOrder(uint32 request_key, Callback.CallMeta meta) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        if (!marketOrderRequests.exists(request_key)) {
            IVexesVault(vault).revert_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, meta
            );
            return;
        }

        MarketOrderRequest _request = marketOrderRequests[request_key];
        delete marketOrderRequests[request_key];

        IVexesVault(vault).finish_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, _request.collateral, meta
        );
    }

    function process_closePosition(
        uint32 position_key,
        uint128 asset_price,
        uint market_idx,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        if (!positions.exists(position_key) || positions[position_key].marketIdx != market_idx) {
            IVexesVault(vault).revert_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, position_key, meta
            );
            return;
        }

        PositionView position_view = getPositionView(position_key, asset_price, accLongFundingPerShare, accShortFundingPerShare);
        delete positions[position_key];

        IVexesVault(vault).finish_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, position_key, position_view, meta
        );
    }

    function applyOpenSpread(uint128 price, IVexesVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IVexesVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function applyCloseSpread(uint128 price, IVexesVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IVexesVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function getPositionsView(
        uint32[] positions_keys,
        uint128[] assets_prices,
        int256[] accLongFundingPerShare,
        int256[] accShortFundingPerShare
    ) external view responsible returns (PositionView[] positions_views) {
        require (positions_keys.length == assets_prices.length, Errors.BAD_INPUT);
        for (uint i = 0; i < positions_keys.length; i++) {
            positions_views.push(getPositionView(positions_keys[i], assets_prices[i], accLongFundingPerShare[i], accShortFundingPerShare[i]));
        }
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }positions_views;
    }

    function getPositionView(
        uint32 position_key,
        uint128 asset_price,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare
    ) public view responsible returns (PositionView position_view) {
        Position position = positions[position_key];
        bool is_long = position.positionType == IVexesVault.PositionType.Long;

        uint128 collateral = position.initialCollateral - position.openFee;
        uint128 leveraged_position = math.muldiv(collateral, position.leverage, LEVERAGE_BASE);

        // borrow fee
        uint32 time_passed = now - position.createdAt;
        uint128 borrow_fee = math.muldiv(position.borrowBaseRatePerHour * time_passed, leveraged_position, HOUR);

        // close price
        uint128 close_price = applyCloseSpread(asset_price, position.positionType, position.baseSpreadRate);

        // funding
        int256 new_acc_funding = is_long ? accLongFundingPerShare : accShortFundingPerShare;
        int256 funding_debt = math.muldiv(leveraged_position, position.accFundingPerShare, SCALING_FACTOR);
        // if funding_fee > 0, trader pays
        int256 funding_fee = math.muldiv(leveraged_position, new_acc_funding, SCALING_FACTOR) - funding_debt;

        // pnl (no funding and borrow fees)
        // (close_price/open_price - 1)
        int256 pnl = int256(math.muldiv(close_price, SCALING_FACTOR, position.openPrice) - SCALING_FACTOR);
        // * (-1) for shorts
        pnl = is_long ? pnl : -pnl;
        // * collateral * leverage
        pnl = math.muldiv(math.muldiv(pnl, collateral, SCALING_FACTOR), position.leverage, LEVERAGE_BASE);

        // liquidation price
        // collateral * 0.9
        int256 liq_price_dist = math.muldiv(collateral, (HUNDRED_PERCENT - position.liquidationThresholdRate),  HUNDRED_PERCENT);
        // - borrow_fee - funding_fee
        liq_price_dist -= borrow_fee + funding_fee;
        // * open_price / collateral / leverage
        liq_price_dist = math.muldiv(math.muldiv(position.openPrice, liq_price_dist, collateral), LEVERAGE_BASE, position.leverage);

        uint128 liq_price = is_long ?
            uint128(math.max(position.openPrice - liq_price_dist, 0)) : // we know that liq price distance is lower than open price
            uint128(math.max(position.openPrice + liq_price_dist, 0));

        // close fee
        int256 updated_position = math.muldiv(
            math.muldiv(close_price, SCALING_FACTOR, position.openPrice),
            leveraged_position,
            SCALING_FACTOR
        );
        updated_position -= math.min(funding_fee + borrow_fee, updated_position);
        // updated_position always positive
        uint128 close_fee = uint128(math.muldiv(updated_position, position.closeFeeRate, HUNDRED_PERCENT));

        // now check if position could be liquidated
//        int256 current_collateral = collateral - borrow_fee - funding_fee + pnl;
//        uint128 liq_threshold = math.muldiv(collateral, position.liquidationThresholdRate, HUNDRED_PERCENT);
//        bool liquidate = current_collateral <= liq_threshold;
        bool liquidate = is_long ? asset_price <= liq_price : asset_price >= liq_price;

        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }PositionView(
            position.marketIdx,
            position.positionType,
            position.initialCollateral,
            leveraged_position,
            position.openPrice,
            close_price,
            position.leverage,
            borrow_fee,
            funding_fee,
            position.openFee,
            close_fee,
            liq_price,
            pnl,
            liquidate,
            position.createdAt
        );
    }

    // TODO: up
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external override onlyVexesVault {}


    function onCodeUpgrade(TvmCell upgrade_data) private {
        tvm.resetStorage();
        tvm.rawReserve(_reserve(), 0);

        TvmSlice s = upgrade_data.toSlice();
        (address root_, , address send_gas_to) = s.decode(address, uint8, address);
        vault = root_;

        platform_code = s.loadRef();

        TvmSlice initialData = s.loadRefAsSlice();
        user = initialData.decode(address);

        TvmSlice params = s.loadRefAsSlice();
        (currentVersion,) = params.decode(uint32, uint32);

        IVexesVault(vault).onVexesAccountDeploy{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, Callback.CallMeta(0, 0, send_gas_to)
        );
    }
}
