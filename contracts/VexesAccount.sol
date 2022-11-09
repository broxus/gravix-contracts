pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/vex_account/VexesAccountBase.sol";


contract VexesAccount is VexesAccountBase {
    // Cant be deployed directly
    constructor() public { revert(); }


    function onDeployRetry(TvmCell, TvmCell, address sendGasTo) external view onlyVexesVault functionID(0x23dc4360){
        tvm.rawReserve(_reserve(), 0);
        sendGasTo.transfer({ value: 0, bounce: false, flag: MsgFlag.ALL_NOT_RESERVED });
    }

    // TODO: up
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external override onlyVexesVault {}


    function onCodeUpgrade(TvmCell upgrade_data) private {
        tvm.resetStorage();
        tvm.rawReserve(_reserve(), 0);

        TvmSlice s = upgrade_data.toSlice();
        (address root_, , address send_gas_to) = s.decode(address, uint8, address);
        vault = root_;

        platform_code = s.loadRef();

        TvmSlice initialData = s.loadRefAsSlice();
        user = initialData.decode(address);

        TvmSlice params = s.loadRefAsSlice();
        (currentVersion,) = params.decode(uint32, uint32);

        IVexesVault(vault).onVexesAccountDeploy{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, Callback.CallMeta(0, 0, send_gas_to)
        );
    }
}
