pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";


interface IVexesVault is IAcceptTokensTransferCallback {
    event NewOwner(uint32 call_id, address new_owner);
    event PlatformCodeInstall(uint32 call_id);
    event VexesAccountCodeUpdate(uint32 call_id, uint32 old_version, uint32 new_version);
    event VexesAccountUpgrade(uint32 call_id, address user, uint32 old_version, uint32 new_version);
    event VexesAccountDeploy(address user);

    function receiveTokenWalletAddress(address wallet) external;
}
