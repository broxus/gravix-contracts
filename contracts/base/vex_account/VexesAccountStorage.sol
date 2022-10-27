pragma ever-solidity ^0.62.0;


import "../../interfaces/IVexesAccount.sol";



abstract contract VexesAccountStorage is IVexesAccount {
    uint32 currentVersion;

    address vault;
    address user;

    TvmCell platform_code;

    mapping (uint32 => MarketOrderRequest) public marketOrderRequests;
    mapping (uint32 => Position) public positions;

    uint32 _nonce = 0;
    uint128 constant CONTRACT_MIN_BALANCE = 1 ever;
    uint128 constant SCALING_FACTOR = 10**18;
    uint32 constant HUNDRED_PERCENT = 1_000_000; // 100%, this allows precision up to 0.0001%
    uint32 constant LEVERAGE_BASE = 100;
    uint32 constant HOUR = 3600;
}
