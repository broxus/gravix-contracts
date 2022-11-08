pragma ever-solidity ^0.62.0;



import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultLiquidityPool.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";


abstract contract VexesVaultMarkets is VexesVaultLiquidityPool {
    function marketOpen(uint market_idx) public view returns (bool open) {
        Market _market = markets[market_idx];

        if (_market.paused) return false;
        if (!_market.scheduleEnabled) return true;

        (
            uint year, uint month, uint day,,,
        ) = DateTimeLib.timestampToDateTime(now);
        uint cur_week_day = DateTimeLib.getDayOfWeek(now);

        // first check if market is shut down because of weekend
        // weekend intervals are sorted by beginning and cant intersect
        // so that its enough to check 1st interval with lower start
        optional(uint32, DateTimeInterval) opt = weekends[market_idx].prevOrEq(now);
        if (opt.hasValue()) {
            (,DateTimeInterval last_weekend) = opt.get();
            if (now <= _dateTimeToTimestamp(last_weekend.to)) return false;
        }

        // now lets check if we are on working hours of market
        mapping (uint8 => TimeInterval) working_hours = workingHours[market_idx];
        if (!working_hours.exists(uint8(cur_week_day))) return false;
        // ok, so, we are on working day, lets get timestamp of start/end of the working day
        TimeInterval work_interval = working_hours[uint8(cur_week_day)];
        DateTime from_dt = _timeToDateTime(year, month, day, work_interval.from);
        DateTime to_dt = _timeToDateTime(year, month, day, work_interval.to);
        if (now < _dateTimeToTimestamp(from_dt) || now > _dateTimeToTimestamp(to_dt)) return false;
        return true;
    }

    // TODO: validate working_hours
    function addMarkets(
        MarketConfig[] new_markets,
        Callback.CallMeta meta
    ) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        for (MarketConfig _market_config : new_markets) {
            require (_market_config.maxLeverage >= LEVERAGE_BASE, Errors.BAD_INPUT);
            require (_market_config.fees.fundingBaseRatePerHour < HUNDRED_PERCENT);
            require (_market_config.fees.borrowBaseRatePerHour < HUNDRED_PERCENT);
            require (_market_config.fees.spreadRate < HUNDRED_PERCENT);
            require (_market_config.fees.closeFeeRate < HUNDRED_PERCENT);
            require (_market_config.fees.openFeeRate < HUNDRED_PERCENT);

            Market new_market;
            new_market.externalId = _market_config.externalId;
            new_market.maxTotalLongs = _market_config.maxLongs;
            new_market.maxTotalShorts = _market_config.maxShorts;
            new_market.noiWeight = _market_config.noiWeight;
            new_market.maxLeverage = _market_config.maxLeverage;
            new_market.depth = _market_config.depth;
            new_market.fees = _market_config.fees;
            new_market.scheduleEnabled = _market_config.scheduleEnabled;

            workingHours[marketCount] = _market_config.workingHours;
            markets[marketCount] = new_market;
            marketCount += 1;

            emit NewMarket(meta.call_id, _market_config);
        }

        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function setMarketsPause(uint[] market_idx, bool[] pause, Callback.CallMeta meta) external onlyMarketManager {
        tvm.rawReserve(_reserve(), 0);
        require (market_idx.length == pause.length, Errors.BAD_INPUT);

        for (uint i = 0; i < market_idx.length; i++) {
            require (markets.exists(market_idx[i]), Errors.BAD_INPUT);

            markets[market_idx[i]].paused = pause[i];

            emit MarketPause(meta.call_id, market_idx[i], pause[i]);
        }

        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function setMarketsWorkingHours(
        uint[] market_idx,
        mapping (uint8 => TimeInterval)[] working_hours, // TODO: validate
        Callback.CallMeta meta
    ) external onlyMarketManager {
        tvm.rawReserve(_reserve(), 0);
        require (market_idx.length == working_hours.length, Errors.BAD_INPUT);

        for (uint i = 0; i < market_idx.length; i++) {
            require (markets.exists(market_idx[i]), Errors.BAD_INPUT);

            workingHours[market_idx[i]] = working_hours[i];

            emit MarketScheduleUpdate(meta.call_id, market_idx[i], working_hours[i]);
        }

        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function addMarketsWeekends(
        uint[] market_idx,
        DateTimeInterval[] new_weekends, // TODO: validate
        Callback.CallMeta meta
    ) external onlyMarketManager {
        tvm.rawReserve(_reserve(), 0);
        require (market_idx.length == new_weekends.length, Errors.BAD_INPUT);

        for (uint i = 0; i < market_idx.length; i++) {
            require (markets.exists(market_idx[i]), Errors.BAD_INPUT);

            DateTimeInterval _new_weekend = new_weekends[i];
            uint32 _new_weekend_start = _dateTimeToTimestamp(_new_weekend.from);
            uint32 _new_weekend_end = _dateTimeToTimestamp(_new_weekend.to);

            optional(uint32, DateTimeInterval) _opt = weekends[market_idx[i]].prevOrEq(_new_weekend_start);
            if (_opt.hasValue()) {
                (, DateTimeInterval _prev_weekend) = _opt.get();
                uint32 _prev_weekend_end = _dateTimeToTimestamp(_prev_weekend.to);

                require (_new_weekend_start >= _prev_weekend_end, Errors.BAD_INPUT);
            }

            optional(uint32, DateTimeInterval) _opt2 = weekends[market_idx[i]].next(_new_weekend_start);
            if (_opt2.hasValue()) {
                (uint32 _next_weekend_start,) = _opt2.get();
                
                require (_next_weekend_start >= _new_weekend_end, Errors.BAD_INPUT);
            }

            weekends[market_idx[i]][_new_weekend_start] = _new_weekend;
            emit MarketWeekends(meta.call_id, market_idx[i], _new_weekend);
        }

        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function clearMarketsWeekends(uint[] market_idx, Callback.CallMeta meta) external onlyMarketManager {
        tvm.rawReserve(_reserve(), 0);

        for (uint i = 0; i < market_idx.length; i++) {
            delete weekends[market_idx[i]];
            emit MarketWeekendsCleared(meta.call_id, market_idx[i]);
        }

        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    function getMarketSchedule(uint market_idx) external view returns (mapping (uint8 => TimeInterval)) {
        return workingHours[market_idx];
    }

    function getMarketWeekends(uint market_idx) external view returns (mapping (uint32 => DateTimeInterval)) {
        return weekends[market_idx];
    }

    function getMarkets() external view returns (mapping (uint => Market) _markets) {
        return markets;
    }
}
