pragma ever-solidity ^0.62.0;

//───────────────────────────────────────────────────────────────────────────────────────────────
//─██████████████─████████████████───██████████████─██████──██████─██████████─████████──████████─
//─██░░░░░░░░░░██─██░░░░░░░░░░░░██───██░░░░░░░░░░██─██░░██──██░░██─██░░░░░░██─██░░░░██──██░░░░██─
//─██░░██████████─██░░████████░░██───██░░██████░░██─██░░██──██░░██─████░░████─████░░██──██░░████─
//─██░░██─────────██░░██────██░░██───██░░██──██░░██─██░░██──██░░██───██░░██─────██░░░░██░░░░██───
//─██░░██─────────██░░████████░░██───██░░██████░░██─██░░██──██░░██───██░░██─────████░░░░░░████───
//─██░░██──██████─██░░░░░░░░░░░░██───██░░░░░░░░░░██─██░░██──██░░██───██░░██───────██░░░░░░██─────
//─██░░██──██░░██─██░░██████░░████───██░░██████░░██─██░░██──██░░██───██░░██─────████░░░░░░████───
//─██░░██──██░░██─██░░██──██░░██─────██░░██──██░░██─██░░░░██░░░░██───██░░██─────██░░░░██░░░░██───
//─██░░██████░░██─██░░██──██░░██████─██░░██──██░░██─████░░░░░░████─████░░████─████░░██──██░░████─
//─██░░░░░░░░░░██─██░░██──██░░░░░░██─██░░██──██░░██───████░░████───██░░░░░░██─██░░░░██──██░░░░██─
//─██████████████─██████──██████████─██████──██████─────██████─────██████████─████████──████████─
//───────────────────────────────────────────────────────────────────────────────────────────────

import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/gravix_vault/GravixVaultBase.sol";
import "./interfaces/IGravixAccount.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";


contract GravixVault is GravixVaultBase {
    constructor(
        address _owner,
        address _market_manager,
        address _usdt,
        address _stg_usdt
    ) public {
        require (tvm.pubkey() != 0, Errors.WRONG_PUBKEY);
        require (tvm.pubkey() == msg.pubkey(), Errors.WRONG_PUBKEY);
        tvm.accept();

        owner = _owner;
        marketManager = _market_manager;
        usdt = _usdt;
        stgUsdt = _stg_usdt;

        _setupTokenWallets();
    }


    // TODO: up
    function upgrade(TvmCell code,  Callback.CallMeta meta) external onlyOwner {
        require (msg.value >= Gas.MIN_MSG_VALUE, Errors.LOW_MSG_VALUE);

        TvmCell data;

        // set code after complete this method
        tvm.setcode(code);

        // run onCodeUpgrade from new code
        tvm.setCurrentCode(code);
        onCodeUpgrade(data);
    }

    function onCodeUpgrade(TvmCell upgrade_data) private {}
}