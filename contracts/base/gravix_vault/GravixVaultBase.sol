pragma ever-solidity ^0.62.0;

import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IGravixAccount.sol";
import "./GravixVaultOrders.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";
import "locklift/src/console.sol";


abstract contract GravixVaultBase is GravixVaultOrders {
    function transferOwnership(address new_owner, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        owner = new_owner;
        emit NewOwner(meta.call_id, new_owner);
    }

    function setMarketManager(address new_manager, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        marketManager = new_manager;
        emit NewMarketManager(meta.call_id, new_manager);
    }

    function setPause(bool new_state, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        paused = new_state;
        emit Pause(meta.call_id, new_state);
    }

    function setLiquidationThresholdRate(uint64 new_rate, Callback.CallMeta meta) external onlyOwner reserveAndSuccessCallback(meta) {
        require (new_rate < HUNDRED_PERCENT, Errors.BAD_INPUT);

        liquidationThresholdRate = new_rate;
        emit LiquidationRateUpdate(meta.call_id, new_rate);
    }

    function setOpenCloseFeeDistributionSchema(
        uint64[2] new_open_fee_schema, uint64[2] new_close_fee_schema, Callback.CallMeta meta
    ) external onlyOwner reserveAndSuccessCallback(meta) {
        require (new_open_fee_schema[0] + new_open_fee_schema[1] == HUNDRED_PERCENT, Errors.BAD_INPUT);
        require (new_close_fee_schema[0] + new_close_fee_schema[1] == HUNDRED_PERCENT, Errors.BAD_INPUT);

        openFeeDistributionSchema = new_open_fee_schema;
        closeFeeDistributionSchema = new_close_fee_schema;

        emit OpenCloseFeeSchemaUpdate(meta.call_id, new_open_fee_schema, new_close_fee_schema);
    }

    function receiveTokenWalletAddress(address wallet) external override {
        if (msg.sender == usdt) usdtWallet = wallet;
        if (msg.sender == stgUsdt) stgUsdtWallet = wallet;
    }

    function onAcceptTokensTransfer(
        address,
        uint128 amount,
        address sender,
        address,
        address remainingGasTo,
        TvmCell payload
    ) external override reserve {
        require (msg.sender == usdtWallet || msg.sender == stgUsdtWallet, Errors.NOT_TOKEN_WALLET);

        (
            Action action,
            uint32 nonce,
            uint32 call_id,
            TvmCell action_payload,
            bool correct
        ) = decodeTokenTransferPayload(payload);
        bool exception = !correct || paused || msg.value < Gas.MIN_MSG_VALUE;

        if (msg.sender == usdtWallet) {
            if (!exception && action == Action.MarketOrder) {
                exception = exception || !_handleMarketOrder(sender, amount, action_payload, Callback.CallMeta(call_id, nonce, remainingGasTo));
            } else if (!exception && action == Action.LiquidityDeposit) {
                _handleUsdtDeposit(sender, amount, Callback.CallMeta(call_id, nonce, remainingGasTo));
            }
        } else if (msg.sender == stgUsdtWallet) {
            if (!exception && action == Action.LiquidityWithdraw) {
                _handleStgUsdtDeposit(sender, amount, Callback.CallMeta(call_id, nonce, remainingGasTo));
            }
        }

        if (exception) {
            emit ActionRevert(call_id, sender);
            // if payload assembled correctly, send nonce, otherwise send payload we got with this transfer
            payload = correct ? _makeCell(nonce) : payload;
            _transfer(msg.sender, amount, sender, payload, remainingGasTo, MsgFlag.ALL_NOT_RESERVED);
        }
    }

    function onAcceptTokensBurn(
        uint128 amount,
        address,
        address wallet,
        address,
        TvmCell payload
    ) external override reserve {
        require (wallet == stgUsdtWallet, Errors.NOT_TOKEN_WALLET);
        require (msg.sender == stgUsdt, Errors.NOT_TOKEN_ROOT);

        _handleStgUsdtBurn(amount, payload);
    }

    onBounce(TvmSlice slice) external view {
        tvm.accept();

        uint32 functionId = slice.decode(uint32);
        // if processing failed - contract was not deployed. Deploy and try again
        if (functionId == tvm.functionId(IGravixAccount.process_requestMarketOrder)) {
            tvm.rawReserve(_reserve(), 0);
            PendingMarketOrder request = slice.decode(PendingMarketOrder);

            address gravix_acc = _deployGravixAccount(request.user);
            IGravixAccount(gravix_acc).process_requestMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(request);
        }
    }
}
