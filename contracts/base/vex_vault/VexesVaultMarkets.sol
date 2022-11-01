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
    //
    //
    //
    //    function addMarket(
    //        uint external_id,
    //        Fees fees,
    //        uint32 max_leverage,
    //        mapping (uint8 => TimeInterval) working_hours, // TODO: validate
    //        Callback.CallMeta meta
    //    ) external onlyOwner {
    //        tvm.rawReserve(_reserve(), 0);
    //
    //        mapping (uint32 => DateTimeInterval) empty;
    //        markets[marketCount] = Market(
    //            external_id, 0, 0, max_leverage, fees, working_hours, empty, false
    //        );
    //        marketCount += 1;
    //
    //        // TODO: add event
    //    }

    //    function setMarketsWorkingHours(
    //        uint[] idx,
    //        mapping (uint8 => TimeInterval)[] working_hours, // TODO: validate
    //        Callback.CallMeta meta
    //    ) external onlyOwner {
    //
    //    }
    //
    //    function addMarketsWeekends(
    //        uint[] idx,
    //        DateTimeInterval[] weekends, // TODO: validate
    //        Callback.CallMeta meta
    //    ) external onlyOwner {
    //
    //    }
    //
    //    function clearMarketsWeekends(uint[] idx, Callback.CallMeta meta) external onlyOwner {
    //
    //    }
    //
    //    function getMarkets() external view returns (mapping (uint => Market) _markets) {
    //        return markets;
    //    }
    //
    //    function setMarketsPause(uint[] idx, bool[] pause_state, Callback.CallMeta meta) external onlyOwner {
    //        tvm.rawReserve(_reserve(), 0);
    //
    //        for (uint i = 0; i < idx.length; i++) {
    //            markets[idx[i]].paused = pause_state[idx[i]];
    //            // TODO: add event
    //        }
    //    }
    //
    //    function setPause(bool pause_state, Callback.CallMeta meta) external onlyOwner {
    //        tvm.rawReserve(_reserve(), 0);
    //
    //        paused = pause_state;
    //        // TODO: add event
    //    }
}
