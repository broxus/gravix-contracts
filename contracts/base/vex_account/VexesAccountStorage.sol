pragma ever-solidity ^0.62.0;


import "../../interfaces/IVexesAccount.sol";



abstract contract VexesAccountStorage is IVexesAccount {
    uint32 currentVersion;

    address vault;
    address user;

    uint32 orderRequestsCount = 0;
    uint32 ordersCount = 0;

    TvmCell platform_code;

    struct OrderRequest {
        uint marketIdx;
        IVexesVault.OrderType orderType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint32 maxSlippage; // %
        uint32 openFee; // %
        uint32 spread; // %
        uint32 borrowBaseRatePerHour; // %
    }

    // TODO: funding acc share ?
    struct Order {
        uint marketIdx;
        IVexesVault.OrderType orderType;
        uint128 collateral;
        uint128 openPrice;
        uint32 leverage;
        uint32 borrowBaseRatePerHour;
    }

    mapping (uint32 => OrderRequest) public orderRequests;
    mapping (uint32 => Order) public orders;

    uint32 _nonce = 0;
    uint128 constant CONTRACT_MIN_BALANCE = 1 ever;
    uint32 constant HUNDRED_PERCENT = 1_000_000; // 100%, this allows precision up to 0.0001%
    uint32 constant LEVERAGE_BASE = 100;
    uint32 constant HOUR = 3600;
}
