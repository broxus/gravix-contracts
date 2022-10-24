pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "../libraries/Callback.sol";


interface IVexesVault is IAcceptTokensTransferCallback {
    enum OrderType { Long, Short }

    struct PendingOrderRequest {
        address user;
        uint marketIdx;
        OrderType orderType;
        uint128 collateral;
        uint128 expectedPrice;
        uint32 leverage;
        uint32 maxSlippage; // %
        uint32 openFee;
        uint32 spread;
        uint32 borrowBaseRatePerHour;
        Callback.CallMeta meta;
    }

    event NewOwner(uint32 call_id, address new_owner);
    event PlatformCodeInstall(uint32 call_id);
    event VexesAccountCodeUpdate(uint32 call_id, uint32 old_version, uint32 new_version);
    event VexesAccountUpgrade(uint32 call_id, address user, uint32 old_version, uint32 new_version);
    event VexesAccountDeploy(address user);
    event ActionRevert(uint32 call_id, address user);
    event OrderRequest(
        uint32 call_id,
        address user,
        uint marketIdx,
        uint128 collateral,
        uint128 expected_price,
        uint32 leverage,
        uint32 max_slippage,
        uint32 request_key
    );
    event OrderRequestRevert(uint32 call_id, address user, uint32 request_key);
    event OrderRequestExecuted(uint32 call_id, address user, uint128 open_price, uint128 open_fee, uint32 request_key);


    function revert_executeOrder(address user, uint32 request_key, uint128 collateral, Callback.CallMeta meta) external;
    function finish_executeOrder(
        address user, uint32 request_key, uint128 open_price, uint128 open_fee, Callback.CallMeta meta
    ) external;
    function receiveTokenWalletAddress(address wallet) external;
    function onVexesAccountDeploy(address user, Callback.CallMeta meta) external view;
    function finish_orderRequest(
        uint32 request_nonce,
        address user,
        uint32 request_key
    ) external;
}
