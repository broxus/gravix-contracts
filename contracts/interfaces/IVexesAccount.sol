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
        uint32 maxSlippageRate; // %
        uint32 openFeeRate; // %
        uint32 closeFeeRate; // %
        uint32 spreadRate; // %
        uint32 liquidationThresholdRate; // %
        uint32 borrowBaseRatePerHour; // %
    }

    // TODO: funding acc share ?
    struct Position {
        uint marketIdx;
        IVexesVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 openFee; // amount of usdt taken when position was opened
        uint128 openPrice;
        uint32 leverage;
        uint32 borrowBaseRatePerHour; // % per hour
        uint32 spreadRate; // %
        uint32 closeFeeRate; // %
        uint32 liquidationThresholdRate; // %
        uint32 createdAt; // %
    }


    struct PositionView {
        uint marketIdx;
        IVexesVault.PositionType positionType;
        uint128 initialCollateral;
        uint128 openPrice;
        uint32 leverage;
        uint128 borrowFee;
        uint128 fundingFee;
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
    function process_executeMarketOrder(uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external;
    function process_closePosition(uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
