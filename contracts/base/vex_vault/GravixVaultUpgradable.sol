pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/Errors.sol";
import "./GravixVaultHelpers.sol";
import {RPlatform as Platform} from "../../Platform.sol";


abstract contract GravixVaultUpgradable is GravixVaultHelpers {
    // TODO: this may be removed ?
    function installPlatformCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        require(platformCode.toSlice().empty(), Errors.ALREADY_INITIALIZED);

        platformCode = code;
        emit PlatformCodeInstall(meta.call_id);
    }

    function installOrUpdateGravixAccountCode(TvmCell code, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        GravixAccountCode = code;
        GravixAccountVersion += 1;
        emit GravixAccountCodeUpdate(meta.call_id, GravixAccountVersion - 1, GravixAccountVersion);
    }

    function upgradeGravixAccount(Callback.CallMeta meta) external view reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE, Errors.LOW_MSG_VALUE);

        _upgradeGravixAccount(msg.sender, 0, meta);
    }

    // admin hook, no need for call_id or nonce
    function forceUpgradeGravixAccounts(address[] users, Callback.CallMeta meta) external view onlyOwner reserve {
        require (msg.value >= Gas.VEX_ACC_UPGRADE_VALUE * (users.length + 1), Errors.LOW_MSG_VALUE);

        for (uint i = 0; i < users.length; i++) {
            _upgradeGravixAccount(users[i], Gas.VEX_ACC_UPGRADE_VALUE, meta);
        }
    }

    function _upgradeGravixAccount(address user, uint128 value, Callback.CallMeta meta) internal view {
        address vex_acc = getGravixAccountAddress(user);
        uint16 flag = value == 0 ? MsgFlag.ALL_NOT_RESERVED : 0;
        IGravixAccount(vex_acc).upgrade{ value: value, flag: flag }(GravixAccountCode, GravixAccountVersion, meta);
    }

    function onGravixAccountUpgrade(
        address user,
        uint32 old_version,
        uint32 new_version,
        Callback.CallMeta meta
    ) external view onlyGravixAccount(user) reserveAndSuccessCallback(meta) {
        emit GravixAccountUpgrade(meta.call_id, user, old_version, new_version);
    }

    function onGravixAccountDeploy(address user, Callback.CallMeta meta) external view override onlyGravixAccount(user) reserveAndSuccessCallback(meta) {
        emit GravixAccountDeploy(user);
    }

    function deployGravixAccount(address user) internal view returns (address) {
        TvmBuilder constructor_params;

        constructor_params.store(GravixAccountVersion); // 32
        constructor_params.store(GravixAccountVersion); // 32

        return new Platform{
            stateInit: _buildGravixAccountInitData(_buildGravixAccountParams(user)),
            value: Gas.Gravix_ACCOUNT_DEPLOY_VALUE
        }(GravixAccountCode, constructor_params.toCell(), user);
    }
}
