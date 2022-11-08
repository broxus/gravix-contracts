pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensBurnCallback.sol";
import "./IVexesAccount.sol";
import "../libraries/Callback.sol";


interface IVexesVault is IAcceptTokensTransferCallback, IAcceptTokensBurnCallback {
    enum Action { MarketOrderRequest, LiquidityDeposit, LiquidityWithdraw }

    struct Time {
        uint8 hour;
        uint8 minute;
    }

    struct DateTime {
        uint16 year;
        uint8 month;
        uint8 day;
        uint8 hour;
        uint8 minute;
    }

    struct TimeInterval {
        Time from;
        Time to;
    }

    struct DateTimeInterval {
        DateTime from;
        DateTime to;
    }

    struct Fees {
        // fee and rates in %
        uint64 openFeeRate;
        uint64 closeFeeRate;
        uint64 spreadRate;
        uint64 borrowBaseRatePerHour;
        uint64 fundingBaseRatePerHour;
    }

    struct Market {
        uint externalId; // some unique identifier? Maybe needed for oracle authentication

        uint128 totalLongs;
        uint128 totalShorts;

        uint128 maxTotalLongs;
        uint128 maxTotalShorts;

        uint16 noiWeight; // 100 -> 1x

        int256 accLongFundingPerShare;
        int256 accShortFundingPerShare;
        uint32 lastFundingUpdateTime;

        uint32 maxLeverage; // 100x = 10_000, e.g multiplied by base (100)
        uint128 depth;

        Fees fees;
        // if this is true, market works only in specified workingHours
        bool scheduleEnabled;
        bool paused;
    }

    enum PositionType { Long, Short }

    struct PendingMarketOrderRequest {
        address user;
        uint marketIdx;
        PositionType positionType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint32 maxSlippageRate; // %
        uint64 openFeeRate; // %
        uint64 closeFeeRate; // %
        uint64 spreadRate; // %
        uint64 liquidationThresholdRate; // %
        uint64 borrowBaseRatePerHour; // %
        Callback.CallMeta meta;
    }

    event NewOwner(uint32 call_id, address new_owner);
    event PlatformCodeInstall(uint32 call_id);
    event VexesAccountCodeUpdate(uint32 call_id, uint32 old_version, uint32 new_version);
    event VexesAccountUpgrade(uint32 call_id, address user, uint32 old_version, uint32 new_version);
    event VexesAccountDeploy(address user);
    event ActionRevert(uint32 call_id, address user);
    event MarketOrderRequest(
        uint32 call_id,
        address user,
        uint marketIdx,
        PositionType request_type,
        uint128 collateral,
        uint128 expected_price,
        uint32 leverage,
        uint32 max_slippage_rate,
        uint32 request_key
    );
    event MarketOrderExecutionRevert(uint32 call_id, address user, uint32 request_key);
    event MarketOrderExecution(
        uint32 call_id,
        address user,
        uint128 position_size,
        PositionType position_type,
        uint128 open_price,
        uint128 open_fee,
        uint32 request_key
    );
    event CancelMarketOrderRevert(uint32 call_id, address user, uint32 request_key);
    event CancelMarketOrder(uint32 call_id, address user, uint32 request_key);
    event ClosePositionRevert(uint32 call_id, address user, uint32 position_key);
    event ClosePosition(uint32 call_id, address user, uint32 position_key, IVexesAccount.PositionView position_view);
    event LiquidatePosition(uint32 call_id, address user, address liquidator, uint32 position_key, IVexesAccount.PositionView position_view);
    event LiquidityPoolDeposit(uint32 call_id, address user, uint128 usdt_amount_in, uint128 stv_usdt_amount_out);
    event LiquidityPoolWithdraw(uint32 call_id, address user, uint128 usdt_amount_out, uint128 stv_usdt_amount_in);

    function receiveTokenWalletAddress(address wallet) external;
    function onVexesAccountDeploy(address user, Callback.CallMeta meta) external view;
    function finish_requestMarketOrder(uint32 request_nonce, address user, uint32 request_key) external;
    function revert_executeMarketOrder(
        address user, uint32 request_key, uint market_idx, uint128 collateral, uint128 position_size, PositionType position_type, Callback.CallMeta meta
    ) external;
    function finish_executeMarketOrder(
        address user,
        uint32 request_key,
        IVexesAccount.Position opened_position,
        Callback.CallMeta meta
    ) external;
    function revert_cancelMarketOrder(address user, uint32 request_key, Callback.CallMeta meta) external view;
    function finish_cancelMarketOrder(address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta) external;
    function revert_closePosition(address user, uint32 position_key, Callback.CallMeta meta) external view;
    function finish_closePosition(
        address user, uint32 position_key, IVexesAccount.PositionView order_view, Callback.CallMeta meta
    ) external;
}
