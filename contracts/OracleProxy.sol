pragma ever-solidity ^0.62.0;


import "./interfaces/IOnRateCallback.sol";
import "./interfaces/IGravixVault.sol";
import "./interfaces/ITWAPOracle.sol";
import "./libraries/Callback.sol";
import "./libraries/Errors.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";


contract OracleProxy is IOnRateCallback {
    uint32 static request_key;
    address static user;
    address static vault;

    address usdt;

    // data that our vault need on callback to finalize trade
    uint32 market_idx;
    uint128 collateral;
    uint32 leverage;
    IGravixVault.PositionType position_type;
    IGravixVault.OracleType price_source;
    IGravixVault.Oracle oracle;
    Callback.CallMeta meta;

    // dex oracle utility staff
    // pair addr => current reserves
    mapping (address => uint128[]) pair_reserves;

    uint128 constant DEX_ORACLE_REQUEST_VALUE = 0.1 ever;
    uint128 constant SCALING_FACTOR = 10**18;

    constructor (
        address _usdt,
        uint32 _market_idx,
        uint128 _collateral,
        uint32 _leverage,
        IGravixVault.PositionType _position_type,
        IGravixVault.OracleType _price_source,
        IGravixVault.Oracle _oracle,
        Callback.CallMeta _meta
    ) public {
        require (msg.sender == vault, Errors.BAD_SENDER);

        usdt = _usdt;
        market_idx = _market_idx;
        collateral = _collateral;
        leverage = _leverage;
        position_type = _position_type;
        price_source = _price_source;
        oracle = _oracle;
        meta = _meta;

        _collectPrice();
    }

    function _collectPrice() internal view {
        if (price_source == IGravixVault.OracleType.ChainlinkProxy) {
            _collectPriceFromChainlink();
        } else {
            _collectPriceFromDex();
        }
    }

    function _collectPriceFromDex() internal view {
        IGravixVault.DexOracle dex = oracle.dex;

        for (uint i = 0; i < dex.path.length; i++) {
            IGravixVault.Pair pair = dex.path[i];
            TvmCell request_payload = abi.encode(i);

            ITWAPOracle(pair.addr).rate{value: DEX_ORACLE_REQUEST_VALUE}(
                now - 1, now, address(this), request_payload
            );
        }
    }

    function _collectPriceFromChainlink() internal view {}

    function _sendCallback(uint128 price) internal view {
        IGravixVault(vault).oracle_executeMarketOrder{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            user,
            request_key,
            market_idx,
            collateral,
            leverage,
            position_type,
            price,
            meta
        );
    }

    // dex oracle callback
    function onRateCallback(
        optional(Rate),
        uint128[] _reserves,
        TvmCell _payload
    ) external override {
        uint idx = abi.decode(_payload, (uint));
        IGravixVault.DexOracle dex = oracle.dex;
        require (msg.sender == dex.path[idx].addr, Errors.BAD_SENDER);

        pair_reserves[msg.sender] = _reserves;

        // TODO: rewrite on prices instead of reserves. This require correct work with decimals in oracles
        if (pair_reserves.keys().length == dex.path.length) {
            // ok, we got all reserves we need
            address target_token = dex.targetToken;
            uint128 price = SCALING_FACTOR; // 1 * 10**18

            for (IGravixVault.Pair pair : dex.path) {
                uint128 pair_price;
                uint128[] reserves = pair_reserves[pair.addr];

                if (pair.leftRoot == target_token) {
                    pair_price = math.muldiv(reserves[1], SCALING_FACTOR, reserves[0]);
                    target_token = pair.rightRoot;
                } else if (pair.rightRoot == target_token) {
                    pair_price = math.muldiv(reserves[0], SCALING_FACTOR, reserves[1]);
                    target_token = pair.leftRoot;
                } else {
                    revert (Errors.BAD_DEX_ORACLE_PATH);
                }
                price = math.muldiv(price, pair_price, SCALING_FACTOR);
            }
            // path should resolve in USDT
            require (target_token == usdt, Errors.BAD_DEX_ORACLE_PATH);
            // convert to final price using standard token decimals
            price = math.muldiv(price, 10**9, SCALING_FACTOR);
            _sendCallback(price);
        }
    }
}
