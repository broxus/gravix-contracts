pragma ever-solidity ^0.62.0;


import "../../interfaces/IVexesVault.sol";


abstract contract VexesVaultStorage is IVexesVault {
    uint32 static deploy_nonce;
    address owner;
    address usdt;
    address usdtWallet;

    TvmCell platformCode;
    TvmCell vexesAccountCode;
    uint32 vexesAccountVersion;
    uint32 vexesVaultVersion;

    uint128 usdtBalance;

    uint128 constant CONTRACT_MIN_BALANCE = 1 ever;
}
