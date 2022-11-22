import {Contract, toNano} from "locklift";
import {Account} from 'locklift/everscale-client'
import {GravixVault} from "./wrappers/vault";
import BigNumber from "bignumber.js";
import {GravixAccountAbi, PairMockAbi} from "../../build/factorySource";
import {bn, toUSD} from "./common";
import {TokenWallet} from "./wrappers/token_wallet";
import {use} from "chai";

const logger = require("mocha-logger");
const {expect} = require("chai");

const TOKEN_DECIMALS = 10**6;
const PERCENT_100 = bn(1_000_000_000_000);
const SCALING_FACTOR = bn(10).pow(18);
const ptype = {0: 'long', 1: 'short'};


async function getPrice(pair: Contract<PairMockAbi>): Promise<string> {
    const reserves = (await pair.methods._reserves().call())._reserves;
    return reserves[1];
}

export async function setPrice(pair: Contract<PairMockAbi>, price: number) {
    const signer = await locklift.keystore.getSigner('0');
    await pair.methods.setReserves({
        // 1 eth and {price}$ in reserves
        // tokens in pairs have 9 decimals
        new_reserves: [10**9, price]
    }).sendExternal({publicKey: signer?.publicKey as string});
}


export async function openMarketOrder(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number
) {
    const initial_price = Number(await getPrice(pair));
    const market = (await vault.contract.methods.getMarket({market_idx: market_idx, answerId: 0}).call())._market;
    let pool_balance = bn((await vault.contract.methods.getDetails({answerId: 0}).call())._poolBalance);

    const position = collateral * (leverage / 100);
    const position_in_asset = position * TOKEN_DECIMALS / initial_price;
    const dynamic_spread = await vault.getDynamicSpread(market_idx, position_in_asset, pos_type);
    const total_spread = bn(market.fees.baseSpreadRate).plus(dynamic_spread);
    const price_multiplier = pos_type == 0 ? PERCENT_100.plus(total_spread) : PERCENT_100.minus(total_spread);
    const expected_price = price_multiplier.times(initial_price).idiv(PERCENT_100);

    // pre-deploy acc, because we dont have bounces yet
    await locklift.tracing.trace(vault.deployGravixAccount(user));
    const account = await vault.account(user);

    const res = (await vault.contract.methods.checkPositionAllowed({
        market_idx: market_idx,
        leverage: leverage,
        collateral: collateral,
        position_type: pos_type,
        asset_price: expected_price.toString()
    }).call()).value0;
    expect(res.toString()).to.be.eq('0');

    const {traceTree} = await locklift.tracing.trace(vault.openPosition(
        user_wallet, collateral, market_idx, pos_type, leverage, expected_price.toString(), 0, 1
    ));
    // await traceTree?.beautyPrint();
    // @ts-ignore
    const [pos_key, pos] = (await account.positions()).pop();

    const open_fee_expected = bn(position).times(market.fees.openFeeRate).idiv(PERCENT_100);

    expect(traceTree).to
        .emit("MarketOrderRequest")
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            collateral: collateral.toString(),
            expected_price: expected_price.toFixed(),
            leverage: leverage.toString(),
            request_type: pos_type.toString(),
            max_slippage_rate: '0',
            marketIdx: market_idx.toString()
        })
        .and
        .emit("MarketOrderExecution")
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            position_type: pos_type.toString(),
            open_price: expected_price.toFixed(),
            open_fee: open_fee_expected.toString()
        });

    const details = await vault.details();
    expect(details._collateralReserve).to.be.eq(bn(collateral).minus(open_fee_expected).toString());
    expect(details._poolBalance).to.be.eq(pool_balance.plus(open_fee_expected).toString());

    const up_collateral = bn(collateral).minus(open_fee_expected);
    const up_position = up_collateral.times(leverage).idiv(100);

    const liq_price_dist = expected_price
        .multipliedBy(up_collateral)
        .multipliedBy(0.9)
        .integerValue()
        .idiv(up_collateral)
        .times(100)
        .idiv(leverage)

    const liq_price = pos_type == 0 ? expected_price.minus(liq_price_dist) : expected_price.plus(liq_price_dist);
    const pos_view = (await account.contract.methods.getPositionView({
        answerId: 0,
        position_key: pos_key,
        asset_price: 0, // doesnt matter, we just need liq_price here
        accLongUSDFundingPerShare: 0,
        accShortUSDFundingPerShare: 0
    }).call()).position_view;

    expect(pos_view.liquidationPrice.toString()).to.be.eq(liq_price.toString());

    logger.log(
        `Opened ${ptype[pos_type]} position,`,
        `market price - ${toUSD(initial_price)}$,`,
        `open price - ${toUSD(expected_price)}\$,`,
        `liquidation price - ${toUSD(liq_price)}\$,`,
        `collateral - ${toUSD(up_collateral)}\$,`,
        `position size - ${toUSD(up_position)}\$,`,
        `open fee - ${toUSD(open_fee_expected)}\$`
    );

    return pos_key;
}


export async function closeOrder(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    pos_key: number
) {
    const finish_price = Number(await getPrice(pair));
    const account = await vault.account(user);

    const pos_view1 = (await account.contract.methods.getPositionView({
        answerId: 0,
        position_key: pos_key,
        asset_price: finish_price,
        accLongUSDFundingPerShare: 0,
        accShortUSDFundingPerShare: 0
    }).call()).position_view;

    const pos_type = Number(pos_view1.position.positionType);
    const market = (await vault.contract.methods.getMarket({market_idx: pos_view1.position.marketIdx, answerId: 0}).call())._market;

    const {traceTree: traceTree1} = await locklift.tracing.trace(vault.closePosition(user, pos_key, 1));
    // await traceTree1?.beautyPrint();

    const price_multiplier1 = pos_type == 0 ? PERCENT_100.minus(market.fees.baseSpreadRate) : PERCENT_100.plus(market.fees.baseSpreadRate);
    const expected_close_price = price_multiplier1.times(finish_price).idiv(PERCENT_100);
    const leveraged_usd = bn(pos_view1.position.initialCollateral)
        .minus(pos_view1.position.openFee)
        .times(pos_view1.position.leverage)
        .idiv(100);
    const leveraged_asset = leveraged_usd.times(TOKEN_DECIMALS).idiv(pos_view1.position.openPrice);

    const event = await vault.getEvent('ClosePosition');
    // console.log(event);

    BigNumber.set({ ROUNDING_MODE: BigNumber.ROUND_FLOOR })
    const expected_close_fee = leveraged_asset
        .times(expected_close_price)
        .idiv(TOKEN_DECIMALS)
        .times(pos_view1.position.closeFeeRate)
        .idiv(PERCENT_100);

    let expected_pnl = expected_close_price
        .times(SCALING_FACTOR)
        .idiv(pos_view1.position.openPrice)
        .minus(SCALING_FACTOR)
        .multipliedBy(pos_type == 0 ? 1 : -1)
        .times(bn(pos_view1.position.initialCollateral).minus(pos_view1.position.openFee))
        .div(SCALING_FACTOR)
        .integerValue(BigNumber.ROUND_FLOOR) // js bignumber cant floor in idiv ;/
        .times(pos_view1.position.leverage)
        .idiv(100);

    expect(pos_view1.closePrice.toString()).to.be.eq(expected_close_price.toString());
    expect(pos_view1.closeFee.toString()).to.be.eq(expected_close_fee.toString());
    expect(pos_view1.pnl.toString()).to.be.eq(expected_pnl.toString());
    expect(pos_view1.liquidate).to.be.false;

    expect(traceTree1).to
        .emit('ClosePosition')
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            position_view: {
                closePrice: expected_close_price.toString(),
                fundingFee: '0',
                borrowFee: '0',
                closeFee: expected_close_fee.toString(),
                pnl: expected_pnl.toString()
            }
        });

    const net_pnl = expected_pnl.minus(expected_close_fee);
    const percent_diff = net_pnl
        .div(bn(pos_view1.position.initialCollateral).minus(pos_view1.position.openFee))
        .times(100);

    const details1 = await vault.details();
    expect(details1._totalNOI.toString()).to.be.eq('0');

    logger.log(
        `Close position, market price - ${toUSD(finish_price)}$,`,
        `close price - ${toUSD(expected_close_price)}\$,`,
        `net pnl ${toUSD(net_pnl)}\$,`,
        `(${percent_diff.toFixed(2)}%),`,
        `close fee - ${toUSD(expected_close_fee)}\$`
    );
}


export async function testMarketPosition(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number,
    initial_price: number,
    finish_price: number
) {
    await setPrice(pair, initial_price);
    // OPEN POSITION
    const pos_key = await openMarketOrder(
        vault,
        pair,
        user,
        user_wallet,
        market_idx,
        pos_type,
        collateral,
        leverage
    );

    // CLOSE POSITION
    await setPrice(pair, finish_price);
    await closeOrder(
        vault,
        pair,
        user,
        user_wallet,
        pos_key
    )
}
