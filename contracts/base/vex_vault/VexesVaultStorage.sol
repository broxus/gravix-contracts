pragma ever-solidity ^0.62.0;


import "../../interfaces/IVexesVault.sol";


abstract contract VexesVaultStorage is IVexesVault {
//    uint32 static deploy_nonce;
    address owner;
    address usdt;
    address usdtWallet;

    TvmCell platformCode;
    TvmCell vexesAccountCode;
    uint32 vexesAccountVersion;
    uint32 vexesVaultVersion;

    // real and virtual balances
    uint128 usdtBalance; // actual usdt balance, equal to sum of all virtual balances
    uint128 poolBalance; // liquidity deposits
    uint128 insuranceFund; // collected fees, pnl and etc.
    uint128 collateralReserve; // sum of all usdt provided as a collateral for open orders

    uint128 totalLongs;
    uint128 totalShorts;

    bool paused;

    uint128 constant CONTRACT_MIN_BALANCE = 1 ever;
    uint32 constant LEVERAGE_BASE = 100;
    uint32 constant HUNDRED_PERCENT = 1_000_000; // 100%, this allows precision up to 0.0001%
    uint32 liquidationThresholdRate = 100_000; // 10%

    uint32[2] openFeeDistributionSchema = [HUNDRED_PERCENT, 0];
    uint32[2] closeFeeDistributionSchema = [0, HUNDRED_PERCENT];

    uint32 marketCount = 0;
    mapping (uint => Market) markets;
    // 2.key - week day, if day is not presented in schedule - market doesnt work
    mapping (uint => mapping (uint8 => TimeInterval)) workingHours;
    // 2.key - weekend interval start timestamp
    mapping (uint => mapping (uint32 => DateTimeInterval)) weekends;

    uint32 request_nonce = 0;
    mapping (uint32 => PendingMarketOrderRequest) pending_market_requests;
}
