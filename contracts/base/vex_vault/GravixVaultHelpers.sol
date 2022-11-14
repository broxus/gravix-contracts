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
import "../../interfaces/IGravixAccount.sol";
import "./GravixVaultStorage.sol";
import "../../OracleProxy.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";
import {RPlatform as Platform} from "../../Platform.sol";


abstract contract GravixVaultHelpers is GravixVaultStorage {
    function getDetails() external view responsible returns (
        address _owner,
        address _marketManager,
        address _usdt,
        address _usdtWallet,
        address _stvUsdt,
        address _stvUsdtWallet,
        uint128 _poolBalance, // liquidity deposits
        uint128 _stvUsdtSupply, // amount of minted stvUsdt
        uint128 _targetPrice,
        uint128 _insuranceFund, // collected fees, pnl and etc.
        uint128 _collateralReserve, // sum of all usdt provided as a collateral for open order
        uint128 _totalLongs,
        uint128 _totalShorts,
        uint128 _totalNOI,
        bool _paused,
        uint64 _liquidationThresholdRate,
        uint64[2] _openFeeDistributionSchema,
        uint64[2] _closeFeeDistributionSchema,
        uint32 _marketCount
    ) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }(
            owner,
            marketManager,
            usdt,
            usdtWallet,
            stvUsdt,
            stvUsdtWallet,
            poolBalance, // liquidity deposits
            stvUsdtSupply, // amount of minted stvUsdt
            targetPrice,
            insuranceFund, // collected fees, pnl and etc.
            collateralReserve, // sum of all usdt provided as a collateral for open order
            totalLongs,
            totalShorts,
            totalNOI,
            paused,
            liquidationThresholdRate,
            openFeeDistributionSchema,
            closeFeeDistributionSchema,
            marketCount
        );
    }

    function getCodes() external view responsible returns (
        TvmCell _oracleProxyCode,
        TvmCell _platformCode,
        TvmCell _GravixAccountCode,
        uint32 _GravixAccountVersion,
        uint32 _GravixVaultVersion
    ) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }(
            oracleProxyCode,
            platformCode,
            GravixAccountCode,
            GravixAccountVersion,
            GravixVaultVersion
        );
    }

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

    function _setupTokenWallets() internal view {
        ITokenRoot(usdt).deployWallet{value: Gas.TOKEN_WALLET_DEPLOY_VALUE, callback: IGravixVault.receiveTokenWalletAddress }(
            address(this), // owner
            Gas.TOKEN_WALLET_DEPLOY_VALUE / 2 // deploy grams
        );
        ITokenRoot(stvUsdt).deployWallet{value: Gas.TOKEN_WALLET_DEPLOY_VALUE, callback: IGravixVault.receiveTokenWalletAddress }(
            address(this), // owner
            Gas.TOKEN_WALLET_DEPLOY_VALUE / 2 // deploy grams
        );
    }

    function _timeToDateTime(uint year, uint month, uint day, Time time) internal pure returns (DateTime dt) {
        return DateTime(uint16(year), uint8(month), uint8(day), time.hour, time.minute);
    }

    function _dateTimeToTimestamp(DateTime dt) internal pure returns (uint32) {
        return uint32(DateTimeLib.timestampFromDateTime(dt.year, dt.month, dt.day, dt.hour, dt.minute, 0));
    }

    function encodeMarketOrderRequestPayload(
        uint32 market_idx,
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
        uint32 market_idx,
        PositionType position_type,
        uint32 leverage,
        uint128 expected_price,
        uint32 max_slippage_rate
    ) {
        TvmSlice slice = action_payload.toSlice();
        (
            market_idx, position_type, leverage, expected_price, max_slippage_rate
        ) = slice.decode(uint32, PositionType, uint32, uint128, uint32);
    }
    
    function encodeLiquidityDeposit(uint32 nonce, uint32 call_id) public pure returns (TvmCell payload) {
        TvmCell empty;
        return encodeTokenTransferPayload(Action.LiquidityDeposit, nonce, call_id, empty);
    }

    function encodeLiquidityWithdraw(uint32 nonce, uint32 call_id) public pure returns (TvmCell payload) {
        TvmCell empty;
        return encodeTokenTransferPayload(Action.LiquidityWithdraw, nonce, call_id, empty);
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
        if ((bits == 8 + 32 + 32) && (refs == 1) && payload.toSlice().decode(uint8) <= uint8(Action.LiquidityWithdraw)) {
            action = slice.decode(Action);
            nonce = slice.decode(uint32);
            call_id = slice.decode(uint32);
            action_payload = slice.loadRef();
            correct = true;
        }
    }

    function getGravixAccountAddress(address user) public view responsible returns (address) {
        return { value: 0, flag: MsgFlag.REMAINING_GAS, bounce: false } address(
            tvm.hash(_buildGravixAccountInitData(_buildGravixAccountParams(user)))
        );
    }

    function getOracleProxyAddress(address user, uint32 request_key) public view responsible returns (address) {
        return { value: 0, flag: MsgFlag.REMAINING_GAS, bounce: false } address(
            tvm.hash(_buildOracleProxyInitData(user, request_key))
        );
    }

    function _makeCell(uint32 nonce) internal pure returns (TvmCell) {
        TvmBuilder builder;
        if (nonce > 0) {
            builder.store(nonce);
        }
        return builder.toCell();
    }

    function _transfer(
        address wallet, uint128 amount, address receiver, TvmCell payload, address send_gas_to, uint16 flag
    ) internal pure {
        uint128 value = flag != MsgFlag.ALL_NOT_RESERVED ? Gas.TOKEN_TRANSFER_VALUE : 0;
        bool notify = false;
        // notify = true if payload is non-empty
        TvmSlice slice = payload.toSlice();
        if (slice.bits() > 0 || slice.refs() > 0) {
            notify = true;
        }
        ITokenWallet(wallet).transfer{value: value, flag: flag}(
            amount,
            receiver,
            0,
            send_gas_to,
            notify,
            payload
        );
    }

    function _buildOracleProxyInitData(address user, uint32 request_key) internal view returns (TvmCell) {
        return tvm.buildStateInit({
            contr: OracleProxy,
            varInit: {
                request_key: request_key,
                user: user,
                vault: address(this)
            },
            pubkey: 0,
            code: oracleProxyCode
        });
    }

    function _buildGravixAccountParams(address user) internal pure returns (TvmCell) {
        TvmBuilder builder;
        builder.store(user);
        return builder.toCell();
    }

    function _buildGravixAccountInitData(TvmCell _initialData) internal view returns (TvmCell) {
        return tvm.buildStateInit({
            contr: Platform,
            varInit: {
                root: address(this),
                platformType: PlatformTypes.GravixAccount,
                initialData: _initialData,
                platformCode: platformCode
            },
            pubkey: 0,
            code: platformCode
        });
    }

    modifier onlyGravixAccount(address user) {
        address vex_account_addr = getGravixAccountAddress(user);
        require (msg.sender == vex_account_addr, Errors.NOT_VEX_ACCOUNT);
        _;
    }

    modifier onlyOracleProxy(address user, uint32 request_key) {
        address proxy = getOracleProxyAddress(user, request_key);
        require (msg.sender == proxy, Errors.NOT_ORACLE_PROXY);
        _;
    }

    function _reserve() internal pure returns (uint128) {
        return math.max(address(this).balance - msg.value, CONTRACT_MIN_BALANCE);
    }

    modifier reserve() {
        tvm.rawReserve(_reserve(), 0);
        _;
    }

    modifier reserveAndSuccessCallback(Callback.CallMeta meta) {
        tvm.rawReserve(_reserve(), 0);
        _;
        _sendCallbackOrGas(msg.sender, meta.nonce, true, meta.send_gas_to);
    }

    modifier reserveAndFailCallback(Callback.CallMeta meta) {
        tvm.rawReserve(_reserve(), 0);
        _;
        _sendCallbackOrGas(msg.sender, meta.nonce, false, meta.send_gas_to);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, Errors.NOT_OWNER);
        _;
    }

    modifier onlyMarketManager() {
        require (msg.sender == owner || msg.sender == marketManager, Errors.NOT_OWNER);
        _;
    }

    modifier onlyActive() {
        require (!paused || msg.sender == owner, Errors.NOT_ACTIVE);
        _;
    }
}
