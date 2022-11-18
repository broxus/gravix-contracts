pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensBurnCallback.sol";
import "./IGravixAccount.sol";
import "../libraries/Callback.sol";


interface IGravixVault is IAcceptTokensTransferCallback, IAcceptTokensBurnCallback {
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

    enum OracleType { ChainlinkProxy, Dex }
    struct Pair {
        address addr;
        address leftRoot;
        address rightRoot;
    }

    struct DexOracle {
        address targetToken;
        // 1st paur should contain target token, last pair should contain USDT
        Pair[] path;
    }

    struct ChainlinkOracle {
        address addr;
    }

    struct Oracle {
        DexOracle dex;
        ChainlinkOracle chainlink;
    }

    struct Fees {
        // fee and rates in %
        uint64 openFeeRate;
        uint64 closeFeeRate;
        uint64 baseSpreadRate;
        uint64 baseDynamicSpreadRate;
        uint64 borrowBaseRatePerHour;
        uint64 fundingBaseRatePerHour;
    }

    struct Market {
        OracleType priceSource;

        uint128 totalLongs;
        uint128 totalShorts;

        uint128 maxTotalLongs;
        uint128 maxTotalShorts;

        uint16 noiWeight; // 100 -> 1x

        int256 accLongFundingPerShare;
        int256 accShortFundingPerShare;
        uint32 lastFundingUpdateTime;

        uint32 maxLeverage; // 100 -> 1x
        uint128 depth;

        Fees fees;
        // if this is true, market works only in specified workingHours
        bool scheduleEnabled;
        bool paused;
    }

    struct PositionIdx {
        address user;
        uint32 positionKey;
    }

    enum PositionType { Long, Short }

    struct PendingMarketOrderRequest {
        address user;
        uint32 marketIdx;
        PositionType positionType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint32 maxSlippageRate; // %
        uint64 openFeeRate; // %
        uint64 closeFeeRate; // %
        uint64 baseSpreadRate; // %
        uint64 liquidationThresholdRate; // %
        uint64 borrowBaseRatePerHour; // %
        Callback.CallMeta meta;
    }

    struct MarketConfig {
        OracleType priceSource;
        uint128 maxLongs;
        uint128 maxShorts;
        uint16 noiWeight;
        uint32 maxLeverage;
        uint128 depth;
        Fees fees;
        bool scheduleEnabled;
        mapping (uint8 => TimeInterval) workingHours;
    }

    event NewOwner(uint32 call_id, address new_owner);
    event GravixAccountCodeUpdate(uint32 call_id, uint32 old_version, uint32 new_version);
    event OracleProxyCodeUpdate(uint32 call_id, uint32 old_version, uint32 new_version);
    event GravixAccountUpgrade(uint32 call_id, address user, uint32 old_version, uint32 new_version);
    event GravixAccountDeploy(address user);
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
    event OraclePriceRequested(
        uint32 call_id,
        uint32 market_idx
    );
    event NewMarket(
        uint32 call_id,
        MarketConfig market
    );
    event MarketConfigUpdate(
        uint32 call_id,
        uint32 market_idx,
        MarketConfig market
    );
    event MarketScheduleUpdate(uint32 call_id, uint32 market_idx, mapping (uint8 => TimeInterval));
    event MarketWeekends(uint32 call_id, uint32 market_idx, DateTimeInterval weekend);
    event MarketWeekendsCleared(uint32 call_id, uint32 market_idx);
    event MarketPause(uint32 call_id, uint32 market_idx, bool new_state);
    event NewMarketManager(uint32 call_id, address new_manager);
    event Pause(uint32 call_id, bool new_state);
    event LiquidationRateUpdate(uint32 call_id, uint64 new_rate);
    event OpenCloseFeeSchemaUpdate(uint32 call_id, uint64[2] new_open_fee_schema, uint64[2] new_close_fee_schema);
    event OracleUpdate(uint32 call_id, uint32 market_idx, Oracle oracle);

    event CancelMarketOrderRevert(uint32 call_id, address user, uint32 request_key);
    event CancelMarketOrder(uint32 call_id, address user, uint32 request_key);
    event ClosePositionRevert(uint32 call_id, address user, uint32 position_key);
    event ClosePosition(uint32 call_id, address user, uint32 position_key, IGravixAccount.PositionView position_view);
    event LiquidatePosition(uint32 call_id, address user, address liquidator, uint32 position_key, IGravixAccount.PositionView position_view);
    event LiquidatePositionRevert(uint32 call_id, address liquidator, address user, uint32 position_key);
    event LiquidityPoolDeposit(uint32 call_id, address user, uint128 usdt_amount_in, uint128 stg_usdt_amount_out);
    event LiquidityPoolWithdraw(uint32 call_id, address user, uint128 usdt_amount_out, uint128 stg_usdt_amount_in);

    function receiveTokenWalletAddress(address wallet) external;
    function onGravixAccountDeploy(address user, Callback.CallMeta meta) external view;
    function oracle_executeMarketOrder(
        uint64 nonce,
        address user,
        uint32 request_key,
        uint32 market_idx,
        uint128 collateral,
        uint32 leverage,
        PositionType position_type,
        uint128 asset_price,
        Callback.CallMeta meta
    ) external;
    function finish_requestMarketOrder(PendingMarketOrderRequest request, uint32 request_key) external;
    function revert_executeMarketOrderManually(
        address user, uint32 request_key, Callback.CallMeta meta
    ) external view;
    function finish_executeMarketOrderManually(
        address user,
        uint32 request_key,
        uint32 market_idx,
        uint128 collateral,
        uint32 leverage,
        PositionType position_type,
        Callback.CallMeta meta
    ) external view;
    function revert_executeMarketOrder(
        address user, uint32 request_key, uint32 market_idx, uint128 collateral, uint128 position_size, PositionType position_type, Callback.CallMeta meta
    ) external;
    function finish_executeMarketOrder(
        address user,
        uint32 request_key,
        IGravixAccount.Position opened_position,
        Callback.CallMeta meta
    ) external;
    function revert_cancelMarketOrder(address user, uint32 request_key, Callback.CallMeta meta) external view;
    function finish_cancelMarketOrder(address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta) external;
    function revert_closePosition(address user, uint32 position_key, Callback.CallMeta meta) external view;
    function oracle_closePosition(
        uint64 nonce,
        address user,
        uint32 position_key,
        uint32 market_idx,
        uint128 asset_price,
        Callback.CallMeta meta
    ) external;
    function process1_closePosition(
        address user, uint32 position_key, uint32 market_idx, Callback.CallMeta meta
    ) external view;
    function finish_closePosition(
        address user, uint32 position_key, IGravixAccount.PositionView order_view, Callback.CallMeta meta
    ) external;
    function oracle_liquidatePositions(
        uint64 nonce, address liquidator, uint32 market_idx, PositionIdx[] positions, uint128 asset_price, Callback.CallMeta meta
    ) external;
    function revert_liquidatePositions(
        address user, address liquidator, uint32 position_key, Callback.CallMeta meta
    ) external view;
    function finish_liquidatePositions(
        address user, address liquidator, uint32 position_key, IGravixAccount.PositionView position_view, Callback.CallMeta meta
    ) external;
}
