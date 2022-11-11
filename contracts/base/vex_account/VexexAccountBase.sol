pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexexVault.sol";
import "./VexexAccountHelpers.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";


abstract contract VexexAccountBase is VexexAccountHelpers {
    function process_requestMarketOrder(
        uint32 request_nonce, IVexexVault.PendingMarketOrderRequest pending_request
    ) external override onlyVexexVault reserve {
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

        IVexexVault(vault).finish_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_nonce, user, _nonce, pending_request.meta
        );
    }

    function process_executeMarketOrder(
        uint32 request_key,
        uint32 market_idx,
        uint128 position_size,
        IVexexVault.PositionType position_type,
        uint128 asset_price,
        uint64 dynamic_spread,
        int256 accFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyVexexVault reserve {
        MarketOrderRequest request = marketOrderRequests[request_key];
        uint128 leveraged_position = math.muldiv(request.collateral, request.leverage, LEVERAGE_BASE);

        if (!marketOrderRequests.exists(request_key)) {
            IVexexVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
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
            IVexexVault(vault).revert_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, market_idx, request.collateral, position_size, position_type, meta
            );
            return;
        }

        uint128 open_fee = math.muldiv(leveraged_position, request.openFeeRate, HUNDRED_PERCENT);

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

        IVexexVault(vault).finish_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, opened_position,  meta
        );
    }

    function process_cancelMarketOrder(uint32 request_key, Callback.CallMeta meta) external override onlyVexexVault reserve {
        if (!marketOrderRequests.exists(request_key)) {
            IVexexVault(vault).revert_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, meta
            );
            return;
        }

        MarketOrderRequest _request = marketOrderRequests[request_key];
        delete marketOrderRequests[request_key];

        IVexexVault(vault).finish_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, _request.collateral, meta
        );
    }

    function process_closePosition(
        uint32 position_key,
        uint128 asset_price,
        uint32 market_idx,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare,
        Callback.CallMeta meta
    ) external override onlyVexexVault reserve {
        if (!positions.exists(position_key) || positions[position_key].marketIdx != market_idx) {
            IVexexVault(vault).revert_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, position_key, meta
            );
            return;
        }

        PositionView position_view = getPositionView(position_key, asset_price, accLongFundingPerShare, accShortFundingPerShare);
        delete positions[position_key];

        IVexexVault(vault).finish_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, position_key, position_view, meta
        );
    }
}
