pragma ever-solidity ^0.62.0;


import "../libraries/Callback.sol";


interface IVexesAccount {
    function prepareOrder(
        uint market_idx,
        uint128 collateral_sub_fee,
        uint128 open_fee,
        uint128 leveraged_position,
        uint128 expected_price,
        uint32 max_slippage,
        uint32 borrow_base_rate_per_hour
    ) external;
    function upgrade(TvmCell new_code, uint32 new_version, Callback.CallMeta meta) external;
}
