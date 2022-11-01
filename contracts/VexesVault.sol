pragma ever-solidity ^0.62.0;

//────────────────────────────────────────────────────────────────────────────────
//─██████──██████─██████████████─████████──████████─██████████████─██████████████─
//─██░░██──██░░██─██░░░░░░░░░░██─██░░░░██──██░░░░██─██░░░░░░░░░░██─██░░░░░░░░░░██─
//─██░░██──██░░██─██░░██████████─████░░██──██░░████─██░░██████████─██░░██████████─
//─██░░██──██░░██─██░░██───────────██░░░░██░░░░██───██░░██─────────██░░██─────────
//─██░░██──██░░██─██░░██████████───████░░░░░░████───██░░██████████─██░░██████████─
//─██░░██──██░░██─██░░░░░░░░░░██─────██░░░░░░██─────██░░░░░░░░░░██─██░░░░░░░░░░██─
//─██░░██──██░░██─██░░██████████───████░░░░░░████───██░░██████████─██████████░░██─
//─██░░░░██░░░░██─██░░██───────────██░░░░██░░░░██───██░░██─────────────────██░░██─
//─████░░░░░░████─██░░██████████─████░░██──██░░████─██░░██████████─██████████░░██─
//───████░░████───██░░░░░░░░░░██─██░░░░██──██░░░░██─██░░░░░░░░░░██─██░░░░░░░░░░██─
//─────██████─────██████████████─████████──████████─██████████████─██████████████─
//────────────────────────────────────────────────────────────────────────────────

import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/vex_vault/VexesVaultOrders.sol";
import "./interfaces/IVexesAccount.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";


contract VexesVault is VexesVaultOrders {
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

        if (!exception && action == Action.MarketOrderRequest) {
            exception = exception && _handleMarketOrderRequest(sender, amount, action_payload, Callback.CallMeta(call_id, nonce, remainingGasTo));
        } else if (!exception && action == Action.LiquidityDeposit) {

        }



        if (exception) {
            emit ActionRevert(call_id, sender);
            // if payload assembled correctly, send nonce, otherwise send payload we got with this transfer
            payload = correct ? _makeCell(nonce) : payload;
            _transferUsdt(amount, sender, payload, remainingGasTo, MsgFlag.ALL_NOT_RESERVED);
        }
    }
//    onBounce(TvmSlice slice) external view {
//        tvm.accept();
//
//        uint32 functionId = slice.decode(uint32);
//        // if processing failed - contract was not deployed. Deploy and try again
//        if (functionId == tvm.functionId(IVexesAccount.process_requestMarketOrder)) {
//            tvm.rawReserve(_reserve(), 0);
//            uint32 _request_nonce = slice.decode(uint32);
//            PendingMarketMarketOrder request = pending_market_requests[_request_nonce];
//
//            address vex_acc = deployVexesAccount(request.user);
//            IVexesAccount(vex_acc).process_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(_request_nonce, request);
//        }
//    }
}
