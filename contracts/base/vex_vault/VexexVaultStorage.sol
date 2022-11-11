pragma ever-solidity ^0.62.0;


import "../../interfaces/IVexexVault.sol";


abstract contract VexexVaultStorage is IVexexVault {
    uint32 static deploy_nonce;

    address owner;
    address marketManager;

    address usdt;
    address usdtWallet;
    address stvUsdt;
    address stvUsdtWallet;

    TvmCell oracleProxyCode;
    TvmCell platformCode;
    TvmCell vexexAccountCode;
    uint32 vexexAccountVersion;
    uint32 vexexVaultVersion;

    // liquidity pool staff
    uint128 poolBalance; // liquidity deposits
    uint128 stvUsdtSupply; // amount of minted stvUsdt
    uint128 targetPrice;

    uint128 insuranceFund; // collected fees, pnl and etc.
    uint128 collateralReserve; // sum of all usdt provided as a collateral for open orders

    uint128 totalLongs;
    uint128 totalShorts;

    // total net open interest across all markets according to weights
    // market noi - abs of (sum of all open longs - sum of all open shorts)
    uint128 totalNOI;

    bool paused;

    uint128 constant SCALING_FACTOR = 10**18;
    uint128 constant CONTRACT_MIN_BALANCE = 1 ever;
    uint8 constant LEVERAGE_BASE = 100; // 100 -> 1x
    uint8 constant WEIGHT_BASE = 100; // 100 -> 1x

    uint64 constant HUNDRED_PERCENT = 1_000_000_000_000; // 100%, this allows precision up to 0.0000000001%
    uint32 constant HOUR = 3600;

    uint64 liquidationThresholdRate = 100_000_000_000; // 10%

    uint64[2] openFeeDistributionSchema = [HUNDRED_PERCENT, 0];
    uint64[2] closeFeeDistributionSchema = [0, HUNDRED_PERCENT];
    enum DistributionSchema { Pool, InsuranceFund }

    uint32 marketCount = 0;
    mapping (uint32 => Market) markets;
    // 2.key - week day, if day is not presented in schedule - market doesnt work
    mapping (uint32 => mapping (uint8 => TimeInterval)) workingHours;
    // 2.key - weekend interval start timestamp
    mapping (uint32 => mapping (uint32 => DateTimeInterval)) weekends;

    mapping (uint32 => Oracle) oracles;

    uint32 request_nonce = 0;
    mapping (uint32 => PendingMarketOrderRequest) pending_market_requests;
}
