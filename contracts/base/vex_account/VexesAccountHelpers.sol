pragma ever-solidity ^0.62.0;


import "./VexesAccountStorage.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/PlatformTypes.sol";
import "../../libraries/Errors.sol";


abstract contract VexesAccountHelpers is VexesAccountStorage {
    function getDetails() external view responsible returns (uint32 _currentVersion, address _vault, address _user) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } (currentVersion, vault, user);
    }

    function applyOpenSpread(uint128 price, IVexesVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IVexesVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function applyCloseSpread(uint128 price, IVexesVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IVexesVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function getPositionsView(
        uint32[] positions_keys,
        uint128[] assets_prices,
        int256[] accLongFundingPerShare,
        int256[] accShortFundingPerShare
    ) external view responsible returns (PositionView[] positions_views) {
        require (positions_keys.length == assets_prices.length, Errors.BAD_INPUT);
        for (uint i = 0; i < positions_keys.length; i++) {
            positions_views.push(getPositionView(positions_keys[i], assets_prices[i], accLongFundingPerShare[i], accShortFundingPerShare[i]));
        }
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }positions_views;
    }

    function getPositionView(
        uint32 position_key,
        uint128 asset_price,
        int256 accLongFundingPerShare,
        int256 accShortFundingPerShare
    ) public view responsible returns (PositionView position_view) {
        Position position = positions[position_key];
        bool is_long = position.positionType == IVexesVault.PositionType.Long;

        uint128 collateral = position.initialCollateral - position.openFee;
        uint128 leveraged_position = math.muldiv(collateral, position.leverage, LEVERAGE_BASE);

        // borrow fee
        uint32 time_passed = now - position.createdAt;
        uint128 borrow_fee = math.muldiv(position.borrowBaseRatePerHour * time_passed, leveraged_position, HOUR);

        // close price
        uint128 close_price = applyCloseSpread(asset_price, position.positionType, position.baseSpreadRate);

        // funding
        int256 new_acc_funding = is_long ? accLongFundingPerShare : accShortFundingPerShare;
        int256 funding_debt = math.muldiv(leveraged_position, position.accFundingPerShare, SCALING_FACTOR);
        // if funding_fee > 0, trader pays
        int256 funding_fee = math.muldiv(leveraged_position, new_acc_funding, SCALING_FACTOR) - funding_debt;

        // pnl (no funding and borrow fees)
        // (close_price/open_price - 1)
        int256 pnl = int256(math.muldiv(close_price, SCALING_FACTOR, position.openPrice) - SCALING_FACTOR);
        // * (-1) for shorts
        pnl = is_long ? pnl : -pnl;
        // * collateral * leverage
        pnl = math.muldiv(math.muldiv(pnl, collateral, SCALING_FACTOR), position.leverage, LEVERAGE_BASE);

        // liquidation price
        // collateral * 0.9
        int256 liq_price_dist = math.muldiv(collateral, (HUNDRED_PERCENT - position.liquidationThresholdRate),  HUNDRED_PERCENT);
        // - borrow_fee - funding_fee
        liq_price_dist -= borrow_fee + funding_fee;
        // * open_price / collateral / leverage
        liq_price_dist = math.muldiv(math.muldiv(position.openPrice, liq_price_dist, collateral), LEVERAGE_BASE, position.leverage);

        uint128 liq_price = is_long ?
        uint128(math.max(position.openPrice - liq_price_dist, 0)) : // we know that liq price distance is lower than open price
        uint128(math.max(position.openPrice + liq_price_dist, 0));

        // close fee
        int256 updated_position = math.muldiv(
            math.muldiv(close_price, SCALING_FACTOR, position.openPrice),
            leveraged_position,
            SCALING_FACTOR
        );
        updated_position -= math.min(funding_fee + borrow_fee, updated_position);
        // updated_position always positive
        uint128 close_fee = uint128(math.muldiv(updated_position, position.closeFeeRate, HUNDRED_PERCENT));

        // now check if position could be liquidated
        //        int256 current_collateral = collateral - borrow_fee - funding_fee + pnl;
        //        uint128 liq_threshold = math.muldiv(collateral, position.liquidationThresholdRate, HUNDRED_PERCENT);
        //        bool liquidate = current_collateral <= liq_threshold;
        bool liquidate = is_long ? asset_price <= liq_price : asset_price >= liq_price;

        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }PositionView(
            position.marketIdx,
            position.positionType,
            position.initialCollateral,
            leveraged_position,
            position.openPrice,
            close_price,
            position.leverage,
            borrow_fee,
            funding_fee,
            position.openFee,
            close_fee,
            liq_price,
            pnl,
            liquidate,
            position.createdAt
        );
    }


    function _reserve() internal pure returns (uint128) {
        return math.max(address(this).balance - msg.value, CONTRACT_MIN_BALANCE);
    }


    modifier reserve() {
        tvm.rawReserve(_reserve(), 0);
        _;
    }

    modifier onlyVexesVault() {
        require (msg.sender == vault, Errors.NOT_VAULT);
        _;
    }
}

