pragma ever-solidity ^0.62.0;



import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultMarkets.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";



abstract contract VexesVaultOrders is VexesVaultMarkets {
    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER REQUEST HANDLERS -------------------------------
    // ----------------------------------------------------------------------------------
    // TODO: NOI ограничения
    function _handleMarketOrderRequest(
        address user, uint128 collateral, TvmCell order_params_payload, Callback.CallMeta meta
    ) internal returns (bool request_saved) {
        (
            uint market_idx,
            PositionType position_type,
            uint32 leverage,
            uint128 expected_price,
            uint32 max_slippage_rate
        ) = decodeMarketOrderRequestPayload(order_params_payload);

        if (!validateOrderRequestParams(market_idx, leverage, max_slippage_rate)) return false;
        if (!marketOpen(market_idx)) return false;
        _marketOrderRequest(user, market_idx, position_type, collateral, leverage, expected_price, max_slippage_rate, meta);
        return true;
    }

    function _marketOrderRequest(
        address user,
        uint market_idx,
        PositionType position_type,
        uint128 collateral,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage_rate, // %
        Callback.CallMeta meta
    ) internal {
        Market _market = markets[market_idx];
        request_nonce += 1;

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
            _market.fees.spreadRate,
            liquidationThresholdRate,
            _market.fees.borrowBaseRatePerHour,
            meta
        );
        pending_market_requests[request_nonce] = new_request;

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(request_nonce, new_request);
    }

    function finish_requestMarketOrder(
        uint32 request_nonce,
        address user,
        uint32 request_key
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        PendingMarketOrderRequest request = pending_market_requests[request_nonce];
        delete pending_market_requests[request_nonce];

        collateralReserve += request.collateral;

        emit MarketOrderRequest(
            request.meta.call_id,
            user,
            request.marketIdx,
            request.collateral,
            request.expectedPrice,
            request.leverage,
            request.maxSlippageRate,
            request_key
        );

        _sendCallbackOrGas(user, request.meta.nonce, true, request.meta.send_gas_to);
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER EXECUTE HANDLERS -------------------------------
    // ----------------------------------------------------------------------------------
    // TODO: authorization for oracle
    function executeOrder(address user, uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external view {
        tvm.rawReserve(_reserve(), 0);

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_key,
            asset_price,
            meta
        );
    }

    function revert_executeMarketOrder(
        address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        collateralReserve -= collateral;

        emit MarketOrderExecutionRevert(
            meta.call_id,
            user,
            request_key
        );

        if (collateral > 0) {
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
        address user, uint32 request_key, uint128 open_price, uint128 open_fee, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        _collectOpenFee(open_fee);
        collateralReserve -= open_fee;

        emit MarketOrderExecution(
            meta.call_id,
            user,
            open_price,
            open_fee,
            request_key
        );

        _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER REQUEST CANCEL HANDLERS ------------------------
    // ----------------------------------------------------------------------------------
    function cancelMarketOrder(address user, uint32 request_key, Callback.CallMeta meta) external view {
        tvm.rawReserve(_reserve(), 0);

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_cancelMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(request_key, meta);
    }

    function revert_cancelMarketOrder(
        address user, uint32 request_key, Callback.CallMeta meta
    ) external view override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        emit CancelMarketOrderRevert(meta.call_id, user, request_key);
        _sendCallbackOrGas(user, meta.nonce, false, meta.send_gas_to);
    }

    function finish_cancelMarketOrder(
        address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        collateralReserve -= collateral;

        emit CancelMarketOrder(meta.call_id, user, request_key);
        _transfer(usdtWallet, collateral, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED);
    }


    // ----------------------------------------------------------------------------------
    // --------------------------- ORDER CLOSE HANDLERS ---------------------------------
    // ----------------------------------------------------------------------------------
    // TODO: add work with oracle
    function closePosition(address user, uint32 position_key, uint128 asset_price, Callback.CallMeta meta) external view {
        tvm.rawReserve(_reserve(), 0);

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_closePosition{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(position_key, asset_price, meta);
    }

    function revert_closePosition(
        address user, uint32 position_key, Callback.CallMeta meta
    ) external view override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        emit ClosePositionRevert(meta.call_id, user, position_key);
        _sendCallbackOrGas(user, meta.nonce, false, meta.send_gas_to);
    }

    function finish_closePosition(
        address user, uint32 position_key, IVexesAccount.PositionView position_view, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        // we already deducted open fee when position was opened
        uint128 collateral = position_view.initialCollateral - position_view.openFee;
        collateralReserve -= collateral;

        if (position_view.liquidate) {
            _increaseInsuranceFund(collateral);

            emit LiquidatePosition(meta.call_id, user, user, position_key, position_view);
            _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
        } else {
            int256 pnl_with_fees = position_view.pnl - position_view.borrowFee - position_view.fundingFee;
            _collectCloseFee(position_view.closeFee);

            if (pnl_with_fees < 0) _increaseInsuranceFund(uint128(math.abs(pnl_with_fees)));
            if (pnl_with_fees > 0) _decreaseInsuranceFund(uint128(pnl_with_fees));

            // we know for sure collateral > pnl and fee, otherwise position would have been liquidated
            uint128 user_net_usdt = uint128(collateral + pnl_with_fees - position_view.closeFee);
            _transfer(usdtWallet, user_net_usdt, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED);
        }
    }

    // ----------------------------------------------------------------------------------
    // --------------------------- LIQUIDATION ------------------------------------------
    // ----------------------------------------------------------------------------------
    //    function liquidatePositions()


}
