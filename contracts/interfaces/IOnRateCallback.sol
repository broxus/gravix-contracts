pragma ton-solidity ^0.62.0;


/// @title OnRate-callback Interface
/// @notice Interface for onRate-callback implementation
interface IOnRateCallback {
    struct Rate {
        /// @dev FP128-price calculated from points' price0To1Cumulative
        uint price0To1;

        /// @dev FP128-price calculated from point's price1To0Cumulative
        uint price1To0;

        /// @dev From-point's timestamp in UNIX seconds
        uint32 fromTimestamp;

        /// @dev To-point's timestamp in UNIX seconds
        uint32 toTimestamp;
    }

/// @notice Handle callback of rate call
    /// @param _rate Calculated rate or null if impossible to calculate
    /// @param _reserves Current pair's reserves
    /// @param _payload Any extra data from the previous call
    function onRateCallback(
        optional(Rate) _rate,
        uint128[] _reserves,
        TvmCell _payload
    ) external;
}
