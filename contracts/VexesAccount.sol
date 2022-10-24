pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import "./base/vex_account/VexesAccountHelpers.sol";
import "./interfaces/IVexesVault.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";


contract VexesAccount is VexesAccountHelpers {
    // Cant be deployed directly
    constructor() public { revert(); }


    function onDeployRetry(TvmCell, TvmCell, address sendGasTo) external view onlyVexesVault functionID(0x23dc4360){
        tvm.rawReserve(_reserve(), 0);
        sendGasTo.transfer({ value: 0, bounce: false, flag: MsgFlag.ALL_NOT_RESERVED });
    }

    function process_orderRequest(uint32 request_nonce, IVexesVault.PendingOrderRequest pending_request) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        _nonce += 1;
        orderRequests[_nonce] = OrderRequest(
            pending_request.marketIdx,
            pending_request.orderType,
            pending_request.collateral,
            pending_request.expectedPrice,
            pending_request.leverage,
            pending_request.maxSlippage,
            pending_request.openFee,
            pending_request.spread,
            pending_request.borrowBaseRatePerHour
        );

        orderRequestsCount += 1;
        IVexesVault(vault).finish_orderRequest{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            request_nonce, user, _nonce
        );
    }

    function process_executeOrder(uint32 request_key, uint128 asset_price, Callback.CallMeta meta) external override onlyVexesVault {
        tvm.rawReserve(_reserve(), 0);

        OrderRequest request = orderRequests[request_key];
        delete orderRequests[request_key];

        uint128 allowed_delta = math.muldiv(request.expectedPrice, request.maxSlippage, HUNDRED_PERCENT);
        uint128 min_price = request.expectedPrice - allowed_delta;
        uint128 max_price = request.expectedPrice + allowed_delta;

        if (asset_price < min_price || asset_price > max_price) {
            IVexesVault(vault).revert_executeOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
                user, request_key, request.collateral, meta
            );
            return;
        }

        uint128 open_price = request.orderType == IVexesVault.OrderType.Long ?
            math.muldiv(asset_price, (HUNDRED_PERCENT + request.spread), HUNDRED_PERCENT) :
            math.muldiv(asset_price, (HUNDRED_PERCENT - request.spread), HUNDRED_PERCENT);

        uint128 leveraged_position = math.muldiv(request.collateral, request.leverage, LEVERAGE_BASE);
        uint128 open_fee = math.muldiv(leveraged_position, request.openFee, HUNDRED_PERCENT);
        uint128 collateral_sub_fee = request.collateral - open_fee;

        ordersCount += 1;
        orders[request_key] = Order(
            request.marketIdx,
            request.orderType,
            collateral_sub_fee,
            open_price,
            request.leverage,
            request.borrowBaseRatePerHour
        );

        IVexesVault(vault).finish_executeOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, request_key, open_price, open_fee, meta
        );
    }

    // TODO: up
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external override {}


    function onCodeUpgrade(TvmCell upgrade_data) private {
        tvm.resetStorage();
        tvm.rawReserve(_reserve(), 0);

        TvmSlice s = upgrade_data.toSlice();
        (address root_, , address send_gas_to) = s.decode(address, uint8, address);
        vault = root_;

        platform_code = s.loadRef();

        TvmSlice initialData = s.loadRefAsSlice();
        user = initialData.decode(address);

        TvmSlice params = s.loadRefAsSlice();
        (currentVersion,) = params.decode(uint32, uint32);

        IVexesVault(vault).onVexesAccountDeploy{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user, Callback.CallMeta(0, 0, send_gas_to)
        );
    }
}
