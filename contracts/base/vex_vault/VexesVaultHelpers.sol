pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/PlatformTypes.sol";
import "../../libraries/Errors.sol";
import "../../interfaces/ICallbackReceiver.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultStorage.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";
import {RPlatform as Platform} from "../../Platform.sol";


abstract contract VexesVaultHelpers is VexesVaultStorage {
    function _sendCallbackOrGas(address callback_receiver, uint32 nonce, bool success, address send_gas_to) internal pure {
        if (nonce > 0) {
            if (success) {
                ICallbackReceiver(
                    callback_receiver
                ).acceptSuccessCallback{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(nonce);
            } else {
                ICallbackReceiver(
                    callback_receiver
                ).acceptFailCallback{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(nonce);
            }
        } else {
            send_gas_to.transfer(0, false, MsgFlag.ALL_NOT_RESERVED);
        }
    }

    function _setupTokenWallet() internal view {
        ITokenRoot(usdt).deployWallet{value: Gas.TOKEN_WALLET_DEPLOY_VALUE, callback: IVexesVault.receiveTokenWalletAddress }(
            address(this), // owner
            Gas.TOKEN_WALLET_DEPLOY_VALUE / 2 // deploy grams
        );
    }


    function validateOrderRequestParams(uint market_idx, uint32 leverage, uint32 max_slippage) public view returns (bool correct) {
        if (!markets.exists(market_idx)) return false;
        Market _market = markets[market_idx];

        if (leverage > _market.maxLeverage) return false;
        if (max_slippage > HUNDRED_PERCENT) return false;
        return true;
    }

    function _timeToDateTime(uint year, uint month, uint day, Time time) internal pure returns (DateTime dt) {
        return DateTime(uint16(year), uint8(month), uint8(day), time.hour, time.minute);
    }

    function _dateTimeToTimestamp(DateTime dt) internal pure returns (uint32) {
        return uint32(DateTimeLib.timestampFromDateTime(dt.year, dt.month, dt.day, dt.hour, dt.minute, 0));
    }

    function encodeMarketOrderRequestPayload(
        uint market_idx,
        PositionType position_type,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage,
        uint32 nonce,
        uint32 call_id
    ) external pure returns (TvmCell payload) {
        TvmBuilder builder;
        builder.store(market_idx, position_type, leverage, expected_price, max_slippage);
        return encodeTokenTransferPayload(Action.MarketOrderRequest, nonce, call_id, builder.toCell());
    }

    function decodeMarketOrderRequestPayload(
        TvmCell action_payload
    ) public pure returns (
        uint market_idx,
        PositionType position_type,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage_rate
    ) {
        TvmSlice slice = action_payload.toSlice();
        (
            market_idx, position_type, leverage, expected_price, max_slippage_rate
        ) = slice.decode(uint, PositionType, uint32, uint128, uint32);
    }

    function encodeTokenTransferPayload(
        Action action, uint32 nonce, uint32 call_id, TvmCell action_payload
    ) public pure returns (TvmCell payload) {
        TvmBuilder builder;
        builder.store(action);
        builder.store(nonce);
        builder.store(call_id);
        builder.storeRef(action_payload);
        return builder.toCell();
    }

    function decodeTokenTransferPayload(TvmCell payload) public pure returns (
        Action action, uint32 nonce, uint32 call_id, TvmCell action_payload, bool correct
    ){
        // check if payload assembled correctly
        TvmSlice slice = payload.toSlice();
        // 1 uint8 + 2 uint32 and 1 cell
        (uint16 bits, uint8 refs) = slice.size();
        if ((bits == 8 + 32 + 32) && (refs == 1) && payload.toSlice().decode(uint8) <= uint8(Action.LiquidityDeposit)) {
            action = slice.decode(Action);
            nonce = slice.decode(uint32);
            call_id = slice.decode(uint32);
            action_payload = slice.loadRef();
            correct = true;
        }
    }

    function getVexesAccountAddress(address user) public view responsible returns (address) {
        return { value: 0, flag: MsgFlag.REMAINING_GAS, bounce: false } address(
            tvm.hash(_buildInitData(_buildVexesAccountParams(user)))
        );
    }

    function _makeCell(uint32 nonce) internal pure returns (TvmCell) {
        TvmBuilder builder;
        if (nonce > 0) {
            builder.store(nonce);
        }
        return builder.toCell();
    }

    function _transferUsdt(
        uint128 amount, address receiver, TvmCell payload, address send_gas_to, uint16 flag
    ) internal view {
        uint128 value;
        if (flag != MsgFlag.ALL_NOT_RESERVED) {
            value = Gas.TOKEN_TRANSFER_VALUE;
        }
        bool notify = false;
        // notify = true if payload is non-empty
        TvmSlice slice = payload.toSlice();
        if (slice.bits() > 0 || slice.refs() > 0) {
            notify = true;
        }
        ITokenWallet(usdtWallet).transfer{value: value, flag: flag}(
            amount,
            receiver,
            0,
            send_gas_to,
            notify,
            payload
        );
    }

    function _buildVexesAccountParams(address user) internal pure returns (TvmCell) {
        TvmBuilder builder;
        builder.store(user);
        return builder.toCell();
    }

    function _buildInitData(TvmCell _initialData) internal view returns (TvmCell) {
        return tvm.buildStateInit({
            contr: Platform,
            varInit: {
                root: address(this),
                platformType: PlatformTypes.VexesAccount,
                initialData: _initialData,
                platformCode: platformCode
            },
            pubkey: 0,
            code: platformCode
        });
    }

    modifier onlyVexesAccount(address user) {
        address vex_account_addr = getVexesAccountAddress(user);
        require (msg.sender == vex_account_addr, Errors.NOT_VEX_ACCOUNT);
        _;
    }

    function _reserve() internal pure returns (uint128) {
        return math.max(address(this).balance - msg.value, CONTRACT_MIN_BALANCE);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, Errors.NOT_OWNER);
        _;
    }

    function _validateHours(mapping (uint8 => TimeInterval)) internal pure returns (bool) {
        // TODO:
        return false;
    }

    function _validateWeekends(mapping (uint32 => DateTimeInterval)) internal pure returns (bool) {
        // TODO:
        return false;
    }
}
