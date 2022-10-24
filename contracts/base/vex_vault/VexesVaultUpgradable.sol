pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/Errors.sol";
import "./VexesVaultHelpers.sol";
import {RPlatform as Platform} from "../../Platform.sol";


abstract contract VexesVaultUpgradable is VexesVaultHelpers {
    function installPlatformCode(TvmCell code, Callback.CallMeta meta) external onlyOwner {
        require(platformCode.toSlice().empty(), Errors.ALREADY_INITIALIZED);

        tvm.rawReserve(_reserve(), 0);

        platformCode = code;
        emit PlatformCodeInstall(meta.call_id);
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function installOrUpdateVexesAccountCode(TvmCell code, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        vexesAccountCode = code;
        vexesAccountVersion += 1;
        emit VexesAccountCodeUpdate(meta.call_id, vexesAccountVersion - 1, vexesAccountVersion);
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function upgradeVexesAccount(Callback.CallMeta meta) external view {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE, Errors.LOW_MSG_VALUE);

        tvm.rawReserve(_reserve(), 0);
        _upgradeVexesAccount(msg.sender, 0, meta);
    }

    // admin hook, no need for call_id or nonce
    function forceUpgradeVexesAccounts(address[] users, Callback.CallMeta meta) external view onlyOwner {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE * (users.length + 1), Errors.LOW_MSG_VALUE);

        tvm.rawReserve(_reserve(), 0);
        for (uint i = 0; i < users.length; i++) {
            _upgradeVexesAccount(users[i], Gas.VEX_ACC_UPGRADE_VALUE, meta);
        }
    }

    function _upgradeVexesAccount(address user, uint128 value, Callback.CallMeta meta) internal view {
        address vex_acc = getVexesAccountAddress(user);
        uint16 flag = value == 0 ? MsgFlag.ALL_NOT_RESERVED : 0;
        IVexesAccount(vex_acc).upgrade{ value: value, flag: flag }(vexesAccountCode, vexesAccountVersion, meta);
    }

    function onVexesAccountUpgrade(
        address user,
        uint32 old_version,
        uint32 new_version,
        Callback.CallMeta meta
    ) external view onlyVexesAccount(user) {
        tvm.rawReserve(_reserve(), 0);

        emit VexesAccountUpgrade(meta.call_id, user, old_version, new_version);
        _sendCallbackOrGas(user, meta.nonce, true, meta.send_gas_to);
    }

    function onVexesAccountDeploy(address user, Callback.CallMeta meta) external view override onlyVexesAccount(user) {
        emit VexesAccountDeploy(user);

        tvm.rawReserve(_reserve(), 0);
        meta.send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
    }

    function deployVexesAccount(address user) public view returns (address) {
        TvmBuilder constructor_params;

        constructor_params.store(vexesAccountVersion); // 32
        constructor_params.store(vexesAccountVersion); // 32

        return new Platform{
            stateInit: _buildInitData(_buildVexesAccountParams(user)),
            value: Gas.VEXES_ACCOUNT_DEPLOY_VALUE
        }(vexesAccountCode, constructor_params.toCell(), user);
    }
}
