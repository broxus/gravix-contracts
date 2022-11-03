pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";
import "./IVexesVault.sol";


interface IVexesAccount {
    struct MarketOrderRequest {
        uint marketIdx;
        IVexesVault.PositionType positionType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint64 maxSlippageRate; // %
        uint64 openFeeRate; // %
        uint64 closeFeeRate; // %
        uint64 spreadRate; // %
        uint64 liquidationThresholdRate; // %
        uint64 borrowBaseRatePerHour; // %
    }

    // TODO: funding acc share ?
    struct Position {
        uint marketIdx;
        IVexesVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 openFee; // amount of usdt taken when position was opened
        uint128 openPrice;
        uint32 leverage;
        int256 accFundingPerShare;
        uint64 borrowBaseRatePerHour; // % per hour
        uint64 spreadRate; // %
        uint64 closeFeeRate; // %
        uint64 liquidationThresholdRate; // %
        uint32 createdAt; // %
    }


    struct PositionView {
        uint marketIdx;
        IVexesVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 openPrice;
        uint128 closePrice;
        uint32 leverage;
        uint128 borrowFee;
        int256 fundingFee;
        uint128 openFee;
        uint128 closeFee;
        uint128 liquidationPrice;
        int256 pnl;
        bool liquidate;
        uint32 createdAt;
    }

    function process_requestMarketOrder(
        uint32 request_nonce,
        IVexesVault.PendingMarketOrderRequest pending_request
    ) external;
    function process_cancelMarketOrder(uint32 request_key, Callback.CallMeta meta) external;
    function process_executeMarketOrder(
        uint32 request_key,
        uint128 asset_price,
        uint market_idx,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare,
        Callback.CallMeta meta
    ) external;
    function process_closePosition(
        uint32 position_key,
        uint128 asset_price,
        uint market_idx,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare,
        Callback.CallMeta meta
    ) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
