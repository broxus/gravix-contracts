pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IGravixVault.sol";
import "./GravixAccountHelpers.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";
import "locklift/src/console.sol";


abstract contract GravixAccountBase is GravixAccountHelpers {
    function process_requestMarketOrder(
        IGravixVault.PendingMarketOrderRequest pending_request
    ) external override onlyGravixVault reserve {
        request_counter += 1;
        marketOrderRequests[request_counter] = MarketOrderRequest(
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

        IGravixVault(vault).finish_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            pending_request, request_counter
        );
    }

    function process_executeMarketOrder(
        uint32 request_key,
        uint32 market_idx,
        uint128 position_size_asset,
        IGravixVault.PositionType position_type,
        uint128 asset_price,
        uint64 dynamic_spread,
        int256 accUSDFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyGravixVault reserve {
        MarketOrderRequest request = marketOrderRequests[request_key];
        uint128 leveraged_position_usd = math.muldiv(request.collateral, request.leverage, LEVERAGE_BASE);

        if (!marketOrderRequests.exists(request_key)) {
            IGravixVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, market_idx, 0, position_size_asset, asset_price, position_type, meta
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
            console.log(format('Min {}, max {}, open {}', min_price, max_price, open_price));
            IGravixVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, market_idx, request.collateral, position_size_asset, asset_price, position_type, meta
            );
            return;
        }

        uint128 open_fee = math.muldiv(leveraged_position_usd, request.openFeeRate, HUNDRED_PERCENT);

        Position opened_position = Position(
            request.marketIdx,
            request.positionType,
            request.collateral,
            open_fee,
            open_price,
            asset_price,
            request.leverage,
            accUSDFundingPerShare,
            request.borrowBaseRatePerHour,
            request.baseSpreadRate,
            request.closeFeeRate,
            request.liquidationThresholdRate,
            now
        );
        positions[request_key] = opened_position;

        IGravixVault(vault).finish_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, opened_position,  meta
        );
    }

    function process_cancelMarketOrder(
        uint32 request_key, Callback.CallMeta meta
    ) external override onlyGravixVault reserve {
        if (!marketOrderRequests.exists(request_key)) {
            IGravixVault(vault).revert_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, meta
            );
            return;
        }

        MarketOrderRequest _request = marketOrderRequests[request_key];
        delete marketOrderRequests[request_key];

        IGravixVault(vault).finish_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, _request.collateral, meta
        );
    }

    function process_liquidatePositions(
        address liquidator,
        uint32 position_key,
        uint128 asset_price,
        int256 accLongUSDFundingPerShare,
        int256 accShortUSDFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyGravixVault reserve {
        if (!positions.exists(position_key)) {
            IGravixVault(vault).revert_liquidatePositions{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, liquidator, position_key, meta
            );
            return;
        }

        PositionView position_view = getPositionView(position_key, asset_price, accLongUSDFundingPerShare, accShortUSDFundingPerShare);
        if (position_view.liquidate) {
            delete positions[position_key];
            IGravixVault(vault).finish_liquidatePositions{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, liquidator, position_key, asset_price, position_view, meta
            );
        } else {
            IGravixVault(vault).revert_liquidatePositions{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, liquidator, position_key, meta
            );
        }
    }

    function process_closePosition(
        uint32 position_key, Callback.CallMeta meta
    ) external view override onlyGravixVault reserve {
        if (!positions.exists(position_key)) {
            IGravixVault(vault).revert_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, position_key, meta
            );
            return;
        }

        Position position = positions[position_key];
        IGravixVault(vault).process1_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, position_key, position.marketIdx, meta
        );
    }

    function process2_closePosition(
        uint32 position_key,
        uint128 asset_price,
        int256 accLongUSDFundingPerShare,
        int256 accShortUSDFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyGravixVault reserve {
        if (!positions.exists(position_key)) {
            IGravixVault(vault).revert_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, position_key, meta
            );
            return;
        }

        PositionView position_view = getPositionView(position_key, asset_price, accLongUSDFundingPerShare, accShortUSDFundingPerShare);
        delete positions[position_key];

        IGravixVault(vault).finish_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, position_key, asset_price, position_view, meta
        );
    }
}
