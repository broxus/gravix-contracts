pragma ever-solidity ^0.62.0;


import "./GravixAccountStorage.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/PlatformTypes.sol";
import "../../libraries/Errors.sol";
import "locklift/src/console.sol";


abstract contract GravixAccountHelpers is GravixAccountStorage {
    function getDetails() external view responsible returns (uint32 _currentVersion, address _vault, address _user) {
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } (currentVersion, vault, user);
    }

    function applyOpenSpread(uint128 price, IGravixVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IGravixVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function applyCloseSpread(uint128 price, IGravixVault.PositionType _type, uint128 spread) public pure responsible returns (uint128 new_price) {
        new_price = _type == IGravixVault.PositionType.Long ?
            math.muldiv(price, (HUNDRED_PERCENT - spread), HUNDRED_PERCENT) :
            math.muldiv(price, (HUNDRED_PERCENT + spread), HUNDRED_PERCENT);
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS } new_price;
    }

    function getPositionsView(
        uint32[] positions_keys,
        uint128[] assets_prices,
        int256[] accLongUSDFundingPerShare,
        int256[] accShortUSDFundingPerShare
    ) external view responsible returns (PositionView[] positions_views) {
        require (positions_keys.length == assets_prices.length, Errors.BAD_INPUT);
        for (uint i = 0; i < positions_keys.length; i++) {
            positions_views.push(getPositionView(positions_keys[i], assets_prices[i], accLongUSDFundingPerShare[i], accShortUSDFundingPerShare[i]));
        }
        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }positions_views;
    }

    function getPositionView(
        uint32 position_key,
        uint128 asset_price,
        int256 accLongUSDFundingPerShare,
        int256 accShortUSDFundingPerShare
    ) public view responsible returns (PositionView position_view) {
        Position position = positions[position_key];
        bool is_long = position.positionType == IGravixVault.PositionType.Long;

        uint128 collateral = position.initialCollateral - position.openFee;
        uint128 leveraged_position_usd = math.muldiv(collateral, position.leverage, LEVERAGE_BASE);
        uint128 leveraged_position_asset = math.muldiv(leveraged_position_usd, USDT_DECIMALS, position.openPrice);

        // borrow fee
        uint32 time_passed = now - position.createdAt;
        uint128 borrow_fee_asset = math.muldiv(position.borrowBaseRatePerHour * time_passed, leveraged_position_asset, HOUR);
        uint128 borrow_fee_usd = math.muldiv(borrow_fee_asset, asset_price, USDT_DECIMALS);

        // close price
        uint128 close_price = applyCloseSpread(asset_price, position.positionType, position.baseSpreadRate);

        // funding
        int256 new_acc_funding = is_long ? accLongUSDFundingPerShare : accShortUSDFundingPerShare;
        int256 funding_debt = math.muldiv(leveraged_position_asset, position.accUSDFundingPerShare, SCALING_FACTOR);
        // if funding_fee > 0, trader pays
        int256 funding_fee_usd = math.muldiv(leveraged_position_asset, new_acc_funding, SCALING_FACTOR) - funding_debt;

        // pnl (no funding and borrow fees)
        // (close_price/open_price - 1)
        int256 pnl = int256(math.muldiv(close_price, SCALING_FACTOR, position.openPrice)) - SCALING_FACTOR;
        // * (-1) for shorts
        pnl = is_long ? pnl : -pnl;
        // * collateral * leverage
        pnl = math.muldiv(math.muldiv(pnl, collateral, SCALING_FACTOR), position.leverage, LEVERAGE_BASE);
        // liquidation price
        // collateral * 0.9
        int256 liq_price_dist = math.muldiv(collateral, (HUNDRED_PERCENT - position.liquidationThresholdRate),  HUNDRED_PERCENT);
        // - borrow_fee - funding_fee_usd
        liq_price_dist -= borrow_fee_usd + funding_fee_usd;
        // * open_price / collateral / leverage
        liq_price_dist = math.muldiv(math.muldiv(position.openPrice, liq_price_dist, collateral), LEVERAGE_BASE, position.leverage);

        uint128 liq_price = is_long ?
            uint128(math.max(position.openPrice - liq_price_dist, 0)) :
            uint128(math.max(position.openPrice + liq_price_dist, 0));

        // close fee
        int256 updated_position = math.muldiv(leveraged_position_asset, close_price, USDT_DECIMALS);
//        math.muldiv(
//            math.muldiv(close_price, SCALING_FACTOR, position.openPrice),
//            leveraged_position_usd,
//            SCALING_FACTOR
//        );
        updated_position -= math.min(funding_fee_usd + borrow_fee_usd, updated_position);
        // updated_position always positive
        uint128 close_fee = uint128(math.muldiv(updated_position, position.closeFeeRate, HUNDRED_PERCENT));

        // now check if position could be liquidated
        //        int256 current_collateral = collateral - borrow_fee - funding_fee + pnl;
        //        uint128 liq_threshold = math.muldiv(collateral, position.liquidationThresholdRate, HUNDRED_PERCENT);
        //        bool liquidate = current_collateral <= liq_threshold;
        bool liquidate = is_long ? asset_price <= liq_price : asset_price >= liq_price;

        return { value: 0, bounce: false, flag: MsgFlag.REMAINING_GAS }PositionView(
            position,
            leveraged_position_usd,
            close_price,
            borrow_fee_usd,
            funding_fee_usd,
            close_fee,
            liq_price,
            pnl,
            liquidate
        );
    }


    function _reserve() internal pure returns (uint128) {
        return math.max(address(this).balance - msg.value, CONTRACT_MIN_BALANCE);
    }


    modifier reserve() {
        tvm.rawReserve(_reserve(), 0);
        _;
    }

    modifier onlyGravixVault() {
        require (msg.sender == vault, Errors.NOT_VAULT);
        _;
    }
}

