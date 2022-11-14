pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";
import "./IGravixVault.sol";


interface IGravixAccount {
    struct MarketOrderRequest {
        uint32 marketIdx;
        IGravixVault.PositionType positionType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint64 maxSlippageRate; // %
        uint64 openFeeRate; // %
        uint64 closeFeeRate; // %
        uint64 baseSpreadRate; // %
        uint64 liquidationThresholdRate; // %
        uint64 borrowBaseRatePerHour; // %
    }

    struct Position {
        uint32 marketIdx;
        IGravixVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 openFee; // amount of usdt taken when position was opened
        uint128 openPrice;
        uint32 leverage;
        int256 accFundingPerShare;
        uint64 borrowBaseRatePerHour; // % per hour
        uint64 baseSpreadRate; // %
        uint64 closeFeeRate; // %
        uint64 liquidationThresholdRate; // %
        uint32 createdAt; // %
    }


    struct PositionView {
        uint32 marketIdx;
        IGravixVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 positionSize;
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
        IGravixVault.PendingMarketOrderRequest pending_request
    ) external;
    function process_cancelMarketOrder(uint32 request_key, Callback.CallMeta meta) external;
    function process_executeMarketOrder(
        uint32 request_key,
        uint32 market_idx,
        uint128 position_size,
        IGravixVault.PositionType position_type,
        uint128 asset_price,
        uint64 dynamic_spread,
        int256 accFundingPerShare,
        Callback.CallMeta meta
    ) external;
    function process_closePosition(
        uint32 position_key,
        uint128 asset_price,
        uint32 market_idx,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare,
        Callback.CallMeta meta
    ) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
