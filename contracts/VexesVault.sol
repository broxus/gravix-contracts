pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "./libraries/Gas.sol";
import "./libraries/Callback.sol";
import {DateTime as DateTimeLib} from "./libraries/DateTime.sol";
import "./base/vault/VexesVaultUpgradable.sol";


contract VexesVault is VexesVaultUpgradable {
    constructor(address _owner, address _usdt) public {
        require (tvm.pubkey() != 0, Errors.WRONG_PUBKEY);
        require (tvm.pubkey() == msg.pubkey(), Errors.WRONG_PUBKEY);

        tvm.accept();
        owner = _owner;
        usdt = _usdt;

        _setupTokenWallet();
    }

    function transferOwnership(address new_owner, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        owner = new_owner;
        emit NewOwner(meta.call_id, new_owner);
        meta.send_gas_to.transfer({ value: 0, bounce: false, flag: MsgFlag.ALL_NOT_RESERVED });
    }

    function receiveTokenWalletAddress(address wallet) external override {
        require (msg.sender == usdt);
        usdtWallet = wallet;
    }

    function onAcceptTokensTransfer(
        address,
        uint128 amount,
        address sender,
        address,
        address remainingGasTo,
        TvmCell payload
    ) external override {
        require (msg.sender == usdtWallet, Errors.NOT_TOKEN_WALLET);
        tvm.rawReserve(_reserve(), 0);

        (
            Action action,
            uint32 nonce,
            uint32 call_id,
            TvmCell action_payload,
            bool correct
        ) = decodeTokenTransferPayload(payload);

        // common cases
        bool exception = !correct || paused || msg.value < Gas.MIN_MSG_VALUE;

        if (!exception && action == Action.PrepareOrder) {
            exception = exception && _handlePrepareOrder(sender, amount, action_payload, Callback.CallMeta(call_id, nonce, remainingGasTo));
        } else if (!exception && action == Action.LiquidityDeposit) {

        }



    }

    function _handlePrepareOrder(
        address user, uint128 collateral, TvmCell order_params_payload, Callback.CallMeta meta
    ) internal view returns (bool order_created) {
        (
            uint market_idx,
            uint32 leverage,
            uint128 expected_price,
            uint32 max_slippage
        ) = decodePrepareOrderPayload(order_params_payload);

        if (!validateOrderParams(market_idx, leverage, max_slippage)) return false;
        if (!marketOpen(market_idx)) return false;
        _prepareOrder(user, market_idx, collateral, leverage, expected_price,max_slippage);
        return true;
    }

    function _prepareOrder(
        address user,
        uint market_idx,
        uint128 collateral,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage // %
    ) internal view {
        Market _market = markets[market_idx];
        uint128 leveragedPosition = math.muldiv(collateral, leverage, LEVERAGE_BASE);
        uint128 openFee = math.muldiv(leveragedPosition, _market.fees.openFee, HUNDRED_PERCENT);
        uint128 collateralSubFee = collateral - openFee;
        leveragedPosition = math.muldiv(collateralSubFee, leverage, LEVERAGE_BASE);

        address vex_acc = getVexesAccountAddress(user);
        IVexesAccount(vex_acc).prepareOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            market_idx, collateralSubFee, openFee, leveragedPosition,
            expected_price, max_slippage, _market.fees.borrowBaseRatePerHour
        );
    }






















//
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

    function setMarketsWorkingHours(
        uint[] idx,
        mapping (uint8 => TimeInterval)[] working_hours, // TODO: validate
        Callback.CallMeta meta
    ) external onlyOwner {

    }

    function addMarketsWeekends(
        uint[] idx,
        DateTimeInterval[] weekends, // TODO: validate
        Callback.CallMeta meta
    ) external onlyOwner {

    }

    function clearMarketsWeekends(uint[] idx, Callback.CallMeta meta) external onlyOwner {

    }

    function getMarkets() external view returns (mapping (uint => Market) _markets) {
        return markets;
    }

    function setMarketsPause(uint[] idx, bool[] pause_state, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        for (uint i = 0; i < idx.length; i++) {
            markets[idx[i]].paused = pause_state[idx[i]];
            // TODO: add event
        }
    }

    function setPause(bool pause_state, Callback.CallMeta meta) external onlyOwner {
        tvm.rawReserve(_reserve(), 0);

        paused = pause_state;
        // TODO: add event
    }
}
