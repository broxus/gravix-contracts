import {Contract} from "locklift";
import {Account} from 'locklift/everscale-client'
import {GravixVault} from "./wrappers/vault";
import BigNumber from "bignumber.js";
import {PairMockAbi} from "../../build/factorySource";
import {bn, toUSD, tryIncreaseTime} from "./common";
import {TokenWallet} from "./wrappers/token_wallet";

const logger = require("mocha-logger");
const {expect} = require("chai");

const TOKEN_DECIMALS = 10 ** 6;
const PRICE_DECIMALS = 10 ** 8;
const PERCENT_100 = bn(1_000_000_000_000);
const SCALING_FACTOR = bn(10).pow(18);
const ptype = {0: 'long', 1: 'short'};


async function getPrice(pair: Contract<PairMockAbi>): Promise<number> {
    const reserves = (await pair.methods._reserves().call())._reserves;
    return Number(reserves[1]) * 100; // 6 to 8 decimals
}

export async function setPrice(pair: Contract<PairMockAbi>, price: number) {
    const signer = await locklift.keystore.getSigner('0');
    await pair.methods.setReserves({
        // 1 eth and {price}$ in reserves
        // tokens in pairs have 9 decimals
        new_reserves: [10 ** 9, price]
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

    const position = collateral * (leverage / 100);
    const position_in_asset = position * PRICE_DECIMALS / initial_price;

    let new_noi;
    if (pos_type === 0) {
        const new_longs_total = bn(market.totalLongsAsset).plus(position_in_asset/2);
        new_noi = new_longs_total.minus(bn(market.totalShortsAsset));
    } else {
        const new_shorts_total = bn(market.totalShortsAsset).plus(position_in_asset/2);
        new_noi = new_shorts_total.minus(bn(market.totalLongsAsset));
    }
    new_noi = new_noi.lt(0) ? bn(0) : new_noi;
    const dynamic_spread = new_noi.times(market.fees.baseDynamicSpreadRate).idiv(market.depthAsset);
    const total_spread = bn(market.fees.baseSpreadRate).plus(dynamic_spread);

    const price_multiplier = pos_type == 0 ? PERCENT_100.plus(total_spread) : PERCENT_100.minus(total_spread);
    const expected_price = price_multiplier.times(initial_price).idiv(PERCENT_100);

    // console.log(expected_price.toFixed());
    // pre-deploy acc, because we dont have bounces yet
    // await locklift.tracing.trace(vault.deployGravixAccount(user));

    const res = (await vault.contract.methods.checkPositionAllowed({
        market_idx: market_idx,
        leverage: leverage,
        collateral: collateral,
        position_type: pos_type,
        asset_price: expected_price.toString()
    }).call()).value0;
    expect(res.toString()).to.be.eq('0');

    const details_prev = await vault.details();
    const {traceTree} = await locklift.tracing.trace(vault.openPosition(
        user_wallet, collateral, market_idx, pos_type, leverage, expected_price.toString(), 0, 1
    ), {allowedCodes: {compute: [null]}});
    // await traceTree?.beautyPrint();
    const account = await vault.account(user);
    // @ts-ignore
    const [pos_key, pos] = (await account.positions()).pop();

    const open_fee_expected = bn(position).times(market.fees.openFeeRate).idiv(PERCENT_100);

    expect(traceTree).to
        .emit("MarketOrder")
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            collateral: collateral.toString(),
            expected_price: expected_price.toFixed(),
            leverage: leverage.toString(),
            position_type: pos_type.toString(),
            max_slippage_rate: '0',
            market_idx: market_idx.toString()
        })
        .and
        .emit("MarketOrderExecution")
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            position: {
                positionType: pos_type.toString(),
                openPrice: expected_price.toFixed(),
                openFee: open_fee_expected.toFixed()
            }
        });

    const event = await vault.getEvent('MarketOrderExecution');

    const details = await vault.details();
    const col_up = bn(collateral).minus(open_fee_expected);

    expect(details._collateralReserve).to.be.eq(bn(details_prev._collateralReserve).plus(col_up).toFixed());
    expect(details._poolBalance).to.be.eq(bn(details_prev._poolBalance).plus(open_fee_expected).toFixed());

    const pos_view = (await account.contract.methods.getPositionView({
        answerId: 0,
        input: {
            positionKey: pos_key,
            assetPrice: 1,
            funding: {
                accLongUSDFundingPerShare: 0,
                accShortUSDFundingPerShare: 0
            }
        }
    }).call()).position_view;

    const leveraged_usd = bn(pos_view.position.initialCollateral)
        .minus(pos_view.position.openFee)
        .times(pos_view.position.leverage)
        .idiv(100);

    const time_passed = bn(pos_view.viewTime).minus(pos_view.position.createdAt);
    const borrow_fee = time_passed
        .times(pos_view.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100)

    const position_up = col_up.times(leverage).idiv(100);
    const liq_price_dist = expected_price
        .multipliedBy(col_up.multipliedBy(0.9).integerValue().minus(borrow_fee))
        .integerValue()
        .idiv(col_up)
        .times(100)
        .idiv(leverage)

    let liq_price = pos_type == 0 ? expected_price.minus(liq_price_dist) : expected_price.plus(liq_price_dist);
    liq_price = pos_type == 0 ?
        liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate)) :
        liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));

    expect(pos_view.liquidationPrice.toString()).to.be.eq(liq_price.toString());

    logger.log(
        `Open ${ptype[pos_type]} position,`,
        `market price - ${toUSD(initial_price / 100)}$,`,
        // @ts-ignore
        `open price - ${toUSD(expected_price / 100)}\$,`,
        // @ts-ignore
        `liquidation price - ${toUSD(liq_price / 100)}\$,`,
        `spread - ${total_spread.div(10 ** 10).toFixed(3)}\%,`,
        `collateral - ${toUSD(col_up)}\$,`,
        `position size - ${toUSD(position_up)}\$,`,
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
        input: {
            positionKey: pos_key,
            assetPrice: finish_price,
            funding: {
                accLongUSDFundingPerShare: 0,
                accShortUSDFundingPerShare: 0
            }
        }
    }).call()).position_view;

    // @ts-ignore
    const pos_type: 0 | 1 = Number(pos_view1.position.positionType);
    const market = (await vault.contract.methods.getMarket({
        market_idx: pos_view1.position.marketIdx,
        answerId: 0
    }).call())._market;

    // const details_prev = await vault.details();
    const {traceTree: traceTree1} = await locklift.tracing.trace(vault.closePosition(user, pos_key, 1));
    // await traceTree1?.beautyPrint();

    const event = await vault.getEvent('ClosePosition');
    // @ts-ignore
    const pos_view2 = event.position_view;

    const price_multiplier1 = pos_type === 0 ? PERCENT_100.minus(market.fees.baseSpreadRate) : PERCENT_100.plus(market.fees.baseSpreadRate);
    const expected_close_price = price_multiplier1.times(finish_price).idiv(PERCENT_100);
    const leveraged_usd = bn(pos_view2.position.initialCollateral)
        .minus(pos_view2.position.openFee)
        .times(pos_view2.position.leverage)
        .idiv(100);
    // const leveraged_asset = leveraged_usd.times(TOKEN_DECIMALS).idiv(pos_view2.position.openPrice);

    // console.log(event);

    const time_passed = bn(pos_view2.viewTime).minus(pos_view2.position.createdAt);
    const borrow_fee = time_passed
        .times(pos_view2.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100)

    expect(borrow_fee.toFixed()).to.be.eq(pos_view2.borrowFee);

    const col_up = bn(pos_view2.position.initialCollateral).minus(pos_view2.position.openFee);

    let expected_pnl = expected_close_price
        .times(SCALING_FACTOR)
        .idiv(pos_view2.position.openPrice)
        .minus(SCALING_FACTOR)
        .multipliedBy(pos_type == 0 ? 1 : -1)
        .times(col_up)
        .div(SCALING_FACTOR)
        .integerValue(BigNumber.ROUND_FLOOR) // js bignumber cant floor in idiv correctly ;/
        .times(pos_view2.position.leverage)
        .idiv(100);

    const liq_price_dist = bn(pos_view2.position.openPrice)
        .multipliedBy(col_up.multipliedBy(0.9).integerValue().minus(borrow_fee))
        .idiv(col_up)
        .times(100)
        .idiv(pos_view2.position.leverage);

    let liq_price = pos_type == 0 ? bn(pos_view2.position.openPrice).minus(liq_price_dist) : bn(pos_view2.position.openPrice).plus(liq_price_dist);
    liq_price = pos_type == 0 ?
        liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate)) :
        liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));

    let up_pos = col_up
      .times(pos_view2.position.leverage)
      .idiv(100)
      .plus(expected_pnl)
      .minus(borrow_fee);
    // console.log(expected_pnl, borrow_fee);
    const expected_close_fee = up_pos.times(pos_view2.position.closeFeeRate).idiv(PERCENT_100);

    expect(liq_price.toFixed()).to.be.eq(pos_view2.liquidationPrice);

    expect(pos_view2.closePrice.toString()).to.be.eq(expected_close_price.toString());
    expect(pos_view2.pnl.toString()).to.be.eq(expected_pnl.toString());
    expect(pos_view2.liquidate).to.be.false;

    expect(traceTree1).to
        .emit('ClosePosition')
        .withNamedArgs({
            call_id: '1',
            user: user.address,
            position_view: {
                closePrice: expected_close_price.toFixed(),
                fundingFee: '0',
                borrowFee: borrow_fee.toFixed(),
                closeFee: expected_close_fee.toFixed(),
                pnl: expected_pnl.toFixed()
            }
        });

    const net_pnl = expected_pnl.minus(expected_close_fee);
    const percent_diff = net_pnl
        .div(bn(pos_view1.position.initialCollateral).minus(pos_view1.position.openFee))
        .times(100);

    // const details1 = await vault.details();
    // expect(details1._totalNOI.toString()).to.be.eq('0');
    logger.log(
        `Close ${ptype[pos_type]} position, market price - ${toUSD(finish_price / 100)}$,`,
        // @ts-ignore
        `close price - ${toUSD(expected_close_price / 100)}\$,`,
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
    finish_price: number,
    ttl= 0
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

    if (ttl > 0) {
        await tryIncreaseTime(ttl);
    }

    // CLOSE POSITION
    await setPrice(pair, finish_price);
    await closeOrder(
        vault,
        pair,
        user,
        user_wallet,
        pos_key
    );
}
