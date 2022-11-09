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

    function addMarkets(
        MarketConfig[] new_markets,
        Callback.CallMeta meta
    ) external onlyOwner reserveAndSuccessCallback(meta) {
        for (MarketConfig _market_config : new_markets) {
            require (validateMarketConfig(_market_config), Errors.BAD_INPUT);

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
    }

    function setMarketsConfigs(
        mapping (uint => MarketConfig) new_configs, Callback.CallMeta meta
    ) external onlyOwner reserveAndSuccessCallback(meta) {
        for ((uint market_idx, MarketConfig config) : new_configs) {
            require (markets.exists(market_idx), Errors.BAD_INPUT);
            require (validateMarketConfig(config), Errors.BAD_INPUT);

            Market market = markets[market_idx];
            market.externalId = config.externalId;
            market.maxTotalLongs = config.maxLongs;
            market.maxTotalShorts = config.maxShorts;
            market.noiWeight = config.noiWeight;
            market.maxLeverage = config.maxLeverage;
            market.depth = config.depth;
            market.fees = config.fees;
            market.scheduleEnabled = config.scheduleEnabled;

            workingHours[market_idx] = config.workingHours;
            markets[market_idx] = market;

            emit MarketConfigUpdate(meta.call_id, market_idx, config);
        }
    }

    function validateMarketConfig(MarketConfig config) public pure returns (bool correct) {
        correct = correct && config.maxLeverage >= LEVERAGE_BASE;
        correct = correct && config.fees.fundingBaseRatePerHour < HUNDRED_PERCENT;
        correct = correct && config.fees.borrowBaseRatePerHour < HUNDRED_PERCENT;
        correct = correct && config.fees.spreadRate < HUNDRED_PERCENT;
        correct = correct && config.fees.closeFeeRate < HUNDRED_PERCENT;
        correct = correct && config.fees.openFeeRate < HUNDRED_PERCENT;

        for ((uint8 key, TimeInterval interval) : config.workingHours) {
            correct = correct && key >= DateTimeLib.DOW_MON && key <= DateTimeLib.DOW_SUN;
            correct = correct && validateTimeInterval(interval);
        }
    }

    function setMarketsPause(
        mapping (uint => bool) pause, Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        for ((uint market_idx, bool new_state) : pause) {
            require (markets.exists(market_idx), Errors.BAD_INPUT);

            markets[market_idx].paused = new_state;
            emit MarketPause(meta.call_id, market_idx, new_state);
        }
    }

    function setMarketsWorkingHours(
        mapping (uint => mapping (uint8 => TimeInterval)) market_to_working_hours,
        Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        for ((uint market_idx, mapping (uint8 => TimeInterval) working_hours) : market_to_working_hours) {
            _setMarketWorkingHours(market_idx, working_hours, meta);
        }
    }

    function setMarketsCommonWorkingHours(
        uint[] market_idx,
        mapping (uint8 => TimeInterval) working_hours,
        Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        for (uint i = 0; i < market_idx.length; i++) {
            _setMarketWorkingHours(market_idx[i], working_hours, meta);
        }
    }

    function _setMarketWorkingHours(
        uint market_idx,
        mapping (uint8 => TimeInterval) working_hours,
        Callback.CallMeta meta
    ) internal {
        require (markets.exists(market_idx), Errors.BAD_INPUT);

        for ((uint8 key, TimeInterval interval) : working_hours) {
            require (key >= DateTimeLib.DOW_MON && key <= DateTimeLib.DOW_SUN, Errors.BAD_INPUT);
            require (validateTimeInterval(interval), Errors.BAD_INPUT);
        }

        workingHours[market_idx] = working_hours;
        emit MarketScheduleUpdate(meta.call_id, market_idx, working_hours);
    }

    function addMarketsWeekends(
        uint[] market_idx,
        DateTimeInterval[] new_weekends,
        Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        require (market_idx.length == new_weekends.length, Errors.BAD_INPUT);

        for (uint i = 0; i < market_idx.length; i++) {
            _addMarketWeekends(market_idx[i], new_weekends[i], meta);
        }
    }

    function addMarketsCommonWeekends(
        uint[] market_idx,
        DateTimeInterval new_weekends,
        Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        for (uint i = 0; i < market_idx.length; i++) {
            _addMarketWeekends(market_idx[i], new_weekends, meta);
        }
    }

    function _addMarketWeekends(
        uint market_idx,
        DateTimeInterval _new_weekend,
        Callback.CallMeta meta
    ) internal {
        require (markets.exists(market_idx), Errors.BAD_INPUT);
        require (validateDateTimeInterval(_new_weekend));

        uint32 _new_weekend_start = _dateTimeToTimestamp(_new_weekend.from);
        uint32 _new_weekend_end = _dateTimeToTimestamp(_new_weekend.to);

        optional(uint32, DateTimeInterval) _opt = weekends[market_idx].prevOrEq(_new_weekend_start);
        if (_opt.hasValue()) {
            (, DateTimeInterval _prev_weekend) = _opt.get();
            uint32 _prev_weekend_end = _dateTimeToTimestamp(_prev_weekend.to);

            require (_new_weekend_start >= _prev_weekend_end, Errors.BAD_INPUT);
        }

        optional(uint32, DateTimeInterval) _opt2 = weekends[market_idx].next(_new_weekend_start);
        if (_opt2.hasValue()) {
            (uint32 _next_weekend_start,) = _opt2.get();

            require (_next_weekend_start >= _new_weekend_end, Errors.BAD_INPUT);
        }

        weekends[market_idx][_new_weekend_start] = _new_weekend;
        emit MarketWeekends(meta.call_id, market_idx, _new_weekend);
    }
    
    function clearMarketsWeekends(
        uint[] market_idx, Callback.CallMeta meta
    ) external onlyMarketManager reserveAndSuccessCallback(meta) {
        for (uint i = 0; i < market_idx.length; i++) {
            delete weekends[market_idx[i]];
            emit MarketWeekendsCleared(meta.call_id, market_idx[i]);
        }
    }

    function validateTimeInterval(TimeInterval val) public pure returns (bool correct) {
        return val.to.hour > val.from.hour || (val.to.hour == val.from.hour && val.to.minute > val.from.minute);
    }

    function validateDateTimeInterval(DateTimeInterval val) public pure returns (bool correct) {
        return _dateTimeToTimestamp(val.to) > _dateTimeToTimestamp(val.from);
    }

    function getMarketSchedule(uint market_idx) external view responsible returns (mapping (uint8 => TimeInterval)) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }workingHours[market_idx];
    }

    function getMarketWeekends(uint market_idx) external view responsible returns (mapping (uint32 => DateTimeInterval)) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }weekends[market_idx];
    }

    function getMarket(uint market_idx) external view responsible returns (Market) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }markets[market_idx];
    }

    function getMarkets() external view responsible returns (mapping (uint => Market) _markets) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }markets;
    }
}
