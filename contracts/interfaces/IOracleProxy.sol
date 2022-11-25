pragma ton-solidity ^0.62.0;


import "./IGravixVault.sol";


interface IOracleProxy {
    function setExecuteCallback(
        address _user,
        uint32 _position_key,
        uint128 _collateral,
        uint32 _leverage,
        IGravixVault.PositionType _position_type
    ) external;

    function setCloseCallback(address _user, uint32 _position_key) external;
    function setLiquidationCallback(address _liquidator, IGravixVault.PositionIdx[] _positions) external;
}
