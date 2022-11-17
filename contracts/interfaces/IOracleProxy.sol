pragma ton-solidity ^0.62.0;


import "./IGravixVault.sol";


interface IOracleProxy {
    function setExecuteCallback(
        uint128 _collateral,
        uint32 _leverage,
        IGravixVault.PositionType _position_type
    ) external;

    function setCloseCallback() external;
}
