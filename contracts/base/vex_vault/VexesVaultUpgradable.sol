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
    // TODO: this may be removed ?
    function installPlatformCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        require(platformCode.toSlice().empty(), Errors.ALREADY_INITIALIZED);

        platformCode = code;
        emit PlatformCodeInstall(meta.call_id);
    }

    function installOrUpdateVexesAccountCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        vexesAccountCode = code;
        vexesAccountVersion += 1;
        emit VexesAccountCodeUpdate(meta.call_id, vexesAccountVersion - 1, vexesAccountVersion);
    }

    function upgradeVexesAccount(Callback.CallMeta meta) external view reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE, Errors.LOW_MSG_VALUE);

        _upgradeVexesAccount(msg.sender, 0, meta);
    }

    // admin hook, no need for call_id or nonce
    function forceUpgradeVexesAccounts(address[] users, Callback.CallMeta meta) external view onlyOwner reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE * (users.length + 1), Errors.LOW_MSG_VALUE);

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
    ) external view onlyVexesAccount(user) reserveAndSuccessCallback(meta) {
        emit VexesAccountUpgrade(meta.call_id, user, old_version, new_version);
    }

    function onVexesAccountDeploy(address user, Callback.CallMeta meta) external view override onlyVexesAccount(user) reserveAndSuccessCallback(meta) {
        emit VexesAccountDeploy(user);
    }

    function deployVexesAccount(address user) internal view returns (address) {
        TvmBuilder constructor_params;

        constructor_params.store(vexesAccountVersion); // 32
        constructor_params.store(vexesAccountVersion); // 32

        return new Platform{
            stateInit: _buildInitData(_buildVexesAccountParams(user)),
            value: Gas.VEXES_ACCOUNT_DEPLOY_VALUE
        }(vexesAccountCode, constructor_params.toCell(), user);
    }
}
