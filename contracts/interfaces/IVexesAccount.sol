pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";
import "./IVexesVault.sol";


interface IVexesAccount {
    function process_orderRequest(
        uint32 request_nonce,
        IVexesVault.PendingOrderRequest pending_request
    ) external;
    function process_executeOrder(uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
