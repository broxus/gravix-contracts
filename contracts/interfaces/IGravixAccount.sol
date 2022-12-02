pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";
import "./IGravixVault.sol";


interface IGravixAccount {
    struct MarketOrder {
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
        uint128 markPrice;
        uint32 leverage;
        int256 accUSDFundingPerShare;
        uint64 borrowBaseRatePerHour; // % per hour
        uint64 baseSpreadRate; // %
        uint64 closeFeeRate; // %
        uint64 liquidationThresholdRate; // %
        uint32 createdAt; // %
    }


    struct PositionView {
        Position position;
        uint128 positionSizeUSD;
        uint128 closePrice;
        uint128 borrowFee;
        int256 fundingFee;
        uint128 closeFee;
        uint128 liquidationPrice;
        int256 pnl;
        bool liquidate;
        uint32 viewTime;
    }

    struct ViewInput {
        uint32 positionKey;
        uint128 assetPrice;
        IGravixVault.Funding funding;
    }

    function process_requestMarketOrder(
        IGravixVault.PendingMarketOrder pending_request
    ) external;
    function process_cancelMarketOrder(uint32 position_key, Callback.CallMeta meta) external;
    function process_executeMarketOrder(
        uint32 position_key,
        uint32 market_idx,
        uint128 position_size,
        IGravixVault.PositionType position_type,
        uint128 asset_price,
        uint64 dynamic_spread,
        int256 accUSDFundingPerShare,
        Callback.CallMeta meta
    ) external;
    function process_closePosition(
        uint32 position_key, Callback.CallMeta meta
    ) external view;
    function process2_closePosition(
        uint32 position_key,
        uint128 asset_price,
        IGravixVault.Funding funding,
        Callback.CallMeta meta
    ) external;
    function process_liquidatePositions(
        address liquidator,
        uint32 position_key,
        uint128 asset_price,
        IGravixVault.Funding funding,
        Callback.CallMeta meta
    ) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
