pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/vex_vault/VexesVaultUpgradable.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";


contract VexesVault is VexesVaultUpgradable {
    constructor(address _owner, address _usdt) public {
        require (tvm.pubkey() != 0, Errors.WRONG_PUBKEY);
        require (tvm.pubkey() == msg.pubkey(), Errors.WRONG_PUBKEY);

        tvm.accept();
        owner = _owner;
        usdt = _usdt;

        _setupTokenWallet();
    }

    function transferOwnership(address new_owner, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        owner = new_owner;
        emit NewOwner(meta.call_id, new_owner);
        meta.send_gas_to.transfer({ value: 0, bounce: false, flag: MsgFlag.ALL_NOT_RESERVED });
    }

    function receiveTokenWalletAddress(address wallet) external override {
        require (msg.sender == usdt);
        usdtWallet = wallet;
    }

    function onAcceptTokensTransfer(
        address,
        uint128 amount,
        address sender,
        address,
        address remainingGasTo,
        TvmCell payload
    ) external override {
        require (msg.sender == usdtWallet, Errors.NOT_TOKEN_WALLET);

        (
            Action action,
            uint32 nonce,
            uint32 call_id,
            TvmCell action_payload,
            bool correct
        ) = decodeTokenTransferPayload(payload);

        // common cases
        bool exception = !correct || paused || msg.value < Gas.MIN_MSG_VALUE;

        if (!exception && action == Action.OrderRequest) {
            exception = exception && _handleOrderRequest(sender, amount, action_payload, Callback.CallMeta(call_id, nonce, remainingGasTo));
        } else if (!exception && action == Action.LiquidityDeposit) {

        }



        if (exception) {
            emit ActionRevert(call_id, sender);
            // if payload assembled correctly, send nonce, otherwise send payload we got with this transfer
            payload = correct ? _makeCell(nonce) : payload;
            _transferUsdt(amount, sender, payload, remainingGasTo, MsgFlag.ALL_NOT_RESERVED);
        }
    }


    // TODO: NOI ограничения
    function _handleOrderRequest(
        address user, uint128 collateral, TvmCell order_params_payload, Callback.CallMeta meta
    ) internal returns (bool request_saved) {
        (
            uint market_idx,
            OrderType order_type,
            uint32 leverage,
            uint128 expected_price,
            uint32 max_slippage
        ) = decodeOrderRequestPayload(order_params_payload);

        if (!validateOrderRequestParams(market_idx, leverage, max_slippage)) return false;
        if (!marketOpen(market_idx)) return false;
        _orderRequest(user, market_idx, order_type, collateral, leverage, expected_price, max_slippage, meta);
        return true;
    }

    function _orderRequest(
        address user,
        uint market_idx,
        OrderType order_type,
        uint128 collateral,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage, // %
        Callback.CallMeta meta
    ) internal {
        tvm.rawReserve(_reserve(), 0);

        Market _market = markets[market_idx];
        request_nonce += 1;

        PendingOrderRequest new_request = PendingOrderRequest(
            user,
            market_idx,
            order_type,
            collateral,
            expected_price,
            leverage,
            max_slippage,
            _market.fees.openFee,
            _market.fees.spread,
            _market.fees.borrowBaseRatePerHour,
            meta
        );
        pending_requests[request_nonce] = new_request;

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_orderRequest{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_nonce,
            new_request
        );
    }

    function finish_orderRequest(
        uint32 request_nonce,
        address user,
        uint32 request_key
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        PendingOrderRequest request = pending_requests[request_nonce];
        delete pending_requests[request_nonce];

        usdtBalance += request.collateral;
        collateralReserve += request.collateral;

        emit OrderRequest(
            request.meta.call_id,
            user,
            request.marketIdx,
            request.collateral,
            request.expectedPrice,
            request.leverage,
            request.maxSlippage,
            request_key
        );

        _sendCallbackOrGas(user, request.meta.nonce, true, request.meta.send_gas_to);
    }

    // TODO: authorization for oracle
    function executeOrder(address user, uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external view {
        tvm.rawReserve(_reserve(), 0);

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).process_executeOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_key,
            asset_price,
            meta
        );
    }

    function revert_executeOrder(
        address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        usdtBalance -= collateral;
        collateralReserve -= collateral;

        emit OrderRequestRevert(
            meta.call_id,
            user,
            request_key
        );

        _transferUsdt(
            collateral, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED
        );
    }

    function finish_executeOrder(
        address user, uint32 request_key, uint128 open_price, uint128 open_fee, Callback.CallMeta meta
    ) external override onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        // TODO: money flow routing!
        insuranceFund += open_fee;

        emit OrderRequestExecuted(
            meta.call_id,
            user,
            open_price,
            open_fee,
            request_key
        );

        _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
    }

    onBounce(TvmSlice slice) external view {
        tvm.accept();

        uint32 functionId = slice.decode(uint32);
        // if processing failed - contract was not deployed. Deploy and try again
        if (functionId == tvm.functionId(IVexesAccount.process_orderRequest)) {
            tvm.rawReserve(_reserve(), 0);
            uint32 _request_nonce = slice.decode(uint32);
            PendingOrderRequest request = pending_requests[_request_nonce];

            address vex_acc = deployVexesAccount(request.user);
            IVexesAccount(vex_acc).process_orderRequest{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(_request_nonce, request);
        }
    }














//
//
//
//
//    function addMarket(
//        uint external_id,
//        Fees fees,
//        uint32 max_leverage,
//        mapping (uint8 => TimeInterval) working_hours, // TODO: validate
//        Callback.CallMeta meta
//    ) external onlyOwner {
//        tvm.rawReserve(_reserve(), 0);
//
//        mapping (uint32 => DateTimeInterval) empty;
//        markets[marketCount] = Market(
//            external_id, 0, 0, max_leverage, fees, working_hours, empty, false
//        );
//        marketCount += 1;
//
//        // TODO: add event
//    }

    function setMarketsWorkingHours(
        uint[] idx,
        mapping (uint8 => TimeInterval)[] working_hours, // TODO: validate
        Callback.CallMeta meta
    ) external onlyOwner {

    }

    function addMarketsWeekends(
        uint[] idx,
        DateTimeInterval[] weekends, // TODO: validate
        Callback.CallMeta meta
    ) external onlyOwner {

    }

    function clearMarketsWeekends(uint[] idx, Callback.CallMeta meta) external onlyOwner {

    }

    function getMarkets() external view returns (mapping (uint => Market) _markets) {
        return markets;
    }

    function setMarketsPause(uint[] idx, bool[] pause_state, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        for (uint i = 0; i < idx.length; i++) {
            markets[idx[i]].paused = pause_state[idx[i]];
            // TODO: add event
        }
    }

    function setPause(bool pause_state, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        paused = pause_state;
        // TODO: add event
    }
}
