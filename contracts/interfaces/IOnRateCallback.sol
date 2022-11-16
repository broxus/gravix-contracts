pragma ton-solidity ^0.62.0;


import "./ITWAPOracle.sol";


/// @title OnRate-callback Interface
/// @notice Interface for onRate-callback implementation
interface IOnRateCallback {
    /// @notice Handle callback of rate call
    /// @param _rate Calculated rate or null if impossible to calculate
    /// @param _reserves Current pair's reserves
    /// @param _payload Any extra data from the previous call
    function onRateCallback(
        optional(ITWAPOracle.Rate) _rate,
        uint128[] _reserves,
        TvmCell _payload
    ) external;
}
