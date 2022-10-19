pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";


interface IVexesAccount {
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
