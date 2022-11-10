pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/Errors.sol";
import "./VexexVaultHelpers.sol";
import {RPlatform as Platform} from "../../Platform.sol";


abstract contract VexexVaultUpgradable is VexexVaultHelpers {
    // TODO: this may be removed ?
    function installPlatformCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        require(platformCode.toSlice().empty(), Errors.ALREADY_INITIALIZED);

        platformCode = code;
        emit PlatformCodeInstall(meta.call_id);
    }

    function installOrUpdateVexexAccountCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        vexexAccountCode = code;
        vexexAccountVersion += 1;
        emit VexexAccountCodeUpdate(meta.call_id, vexexAccountVersion - 1, vexexAccountVersion);
    }

    function upgradeVexexAccount(Callback.CallMeta meta) external view reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE, Errors.LOW_MSG_VALUE);

        _upgradeVexexAccount(msg.sender, 0, meta);
    }

    // admin hook, no need for call_id or nonce
    function forceUpgradeVexexAccounts(address[] users, Callback.CallMeta meta) external view onlyOwner reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE * (users.length + 1), Errors.LOW_MSG_VALUE);

        for (uint i = 0; i < users.length; i++) {
            _upgradeVexexAccount(users[i], Gas.VEX_ACC_UPGRADE_VALUE, meta);
        }
    }

    function _upgradeVexexAccount(address user, uint128 value, Callback.CallMeta meta) internal view {
        address vex_acc = getVexexAccountAddress(user);
        uint16 flag = value == 0 ? MsgFlag.ALL_NOT_RESERVED : 0;
        IVexexAccount(vex_acc).upgrade{ value: value, flag: flag }(vexexAccountCode, vexexAccountVersion, meta);
    }

    function onVexexAccountUpgrade(
        address user,
        uint32 old_version,
        uint32 new_version,
        Callback.CallMeta meta
    ) external view onlyVexexAccount(user) reserveAndSuccessCallback(meta) {
        emit VexexAccountUpgrade(meta.call_id, user, old_version, new_version);
    }

    function onVexexAccountDeploy(address user, Callback.CallMeta meta) external view override onlyVexexAccount(user) reserveAndSuccessCallback(meta) {
        emit VexexAccountDeploy(user);
    }

    function deployVexexAccount(address user) internal view returns (address) {
        TvmBuilder constructor_params;

        constructor_params.store(vexexAccountVersion); // 32
        constructor_params.store(vexexAccountVersion); // 32

        return new Platform{
            stateInit: _buildInitData(_buildVexexAccountParams(user)),
            value: Gas.VEXEX_ACCOUNT_DEPLOY_VALUE
        }(vexexAccountCode, constructor_params.toCell(), user);
    }
}
