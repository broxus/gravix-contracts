pragma ever-solidity ^0.62.0;


import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultOrders.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";


abstract contract VexesVaultBase is VexesVaultOrders {
    function transferOwnership(address new_owner, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        owner = new_owner;
        emit NewOwner(meta.call_id, new_owner);
        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function setMarketManager(address new_manager, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        marketManager = new_manager;
        emit NewMarketManager(meta.call_id, new_manager);
        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function setPause(bool new_state, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        paused = new_state;
        emit Pause(meta.call_id, new_state);

        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function receiveTokenWalletAddress(address wallet) external override {
        if (msg.sender == usdt) usdtWallet = wallet;
        if (msg.sender == stvUsdt) stvUsdtWallet = wallet;
    }

    function onAcceptTokensTransfer(
        address,
        uint128 amount,
        address sender,
        address,
        address remainingGasTo,
        TvmCell payload
    ) external override {
        require (msg.sender == usdtWallet || msg.sender == stvUsdtWallet, Errors.NOT_TOKEN_WALLET);
        tvm.rawReserve(_reserve(), 0);

        (
            Action action,
            uint32 nonce,
            uint32 call_id,
            TvmCell action_payload,
            bool correct
        ) = decodeTokenTransferPayload(payload);
        bool exception = !correct || paused || msg.value < Gas.MIN_MSG_VALUE;

        if (msg.sender == usdtWallet) {
            if (!exception && action == Action.MarketOrderRequest) {
                exception = exception && _handleMarketOrderRequest(sender, amount, action_payload, Callback.CallMeta(call_id, nonce, remainingGasTo));
            } else if (!exception && action == Action.LiquidityDeposit) {
                _handleUsdtDeposit(sender, amount, Callback.CallMeta(call_id, nonce, remainingGasTo));
            }
        } else if (msg.sender == stvUsdtWallet) {
            if (!exception && action == Action.LiquidityWithdraw) {
                _handleStvUsdtDeposit(sender, amount, Callback.CallMeta(call_id, nonce, remainingGasTo));
            }
        }

        if (exception) {
            emit ActionRevert(call_id, sender);
            // if payload assembled correctly, send nonce, otherwise send payload we got with this transfer
            payload = correct ? _makeCell(nonce) : payload;
            _transfer(msg.sender, amount, sender, payload, remainingGasTo, MsgFlag.ALL_NOT_RESERVED);
        }
    }

    function onAcceptTokensBurn(
        uint128 amount,
        address,
        address wallet,
        address,
        TvmCell payload
    ) external override {
        require (wallet == stvUsdtWallet, Errors.NOT_TOKEN_WALLET);
        require (msg.sender == stvUsdt, Errors.NOT_TOKEN_ROOT);
        tvm.rawReserve(_reserve(), 0);

        _handleStvUsdtBurn(amount, payload);
    }

    onBounce(TvmSlice slice) external view {
        tvm.accept();

        uint32 functionId = slice.decode(uint32);
        // if processing failed - contract was not deployed. Deploy and try again
        if (functionId == tvm.functionId(IVexesAccount.process_requestMarketOrder)) {
            tvm.rawReserve(_reserve(), 0);
            uint32 _request_nonce = slice.decode(uint32);
            PendingMarketOrderRequest request = pending_market_requests[_request_nonce];

            address vex_acc = deployVexesAccount(request.user);
            IVexesAccount(vex_acc).process_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(_request_nonce, request);
        }
    }
}
