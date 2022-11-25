pragma ever-solidity ^0.62.0;


import "../../interfaces/IGravixAccount.sol";



abstract contract GravixAccountStorage is IGravixAccount {
    uint32 currentVersion;

    address vault;
    address user;

    TvmCell platform_code;

    mapping (uint32 => MarketOrder) public marketOrders;
    mapping (uint32 => Position) public positions;

    uint32 request_counter = 0;
    uint128 constant CONTRACT_MIN_BALANCE = 0.5 ever;
    uint128 constant SCALING_FACTOR = 10**18;
    uint128 constant USDT_DECIMALS = 10**6;
    uint64 constant HUNDRED_PERCENT = 1_000_000_000_000; // 100%, this allows precision up to 0.0000000001%
    uint8 constant LEVERAGE_BASE = 100;
    uint32 constant HOUR = 3600;
}
