import { Address, Contract, getRandomNonce, toNano, zeroAddress } from "locklift";
import { Account } from "locklift/everscale-client";
import { GravixVault } from "./wrappers/vault";
import BigNumber from "bignumber.js";
import { PairMockAbi } from "../../build/factorySource";
import { bn, getPriceForLimitOrder, toUSD, tryIncreaseTime } from "./common";
import { TokenWallet } from "./wrappers/token_wallet";
import { LimitType, PosType } from "./constants";

const logger = require("mocha-logger");
const { expect } = require("chai");

const PRICE_DECIMALS = 10 ** 8;
const PERCENT_100 = bn(1_000_000_000_000);
const SCALING_FACTOR = bn(10).pow(18);
const ptype = { 0: "long", 1: "short" };
const empty_price = {
    price: 0,
    serverTime: 0,
    oracleTime: 0,
    ticker: "",
    signature: "",
};
export async function getPrice(pair: Contract<PairMockAbi>): Promise<number> {
    const reserves = (await pair.methods._reserves().call())._reserves;
    return Number(reserves[1]) * 100; // 6 to 8 decimals
}

export async function setPrice(pair: Contract<PairMockAbi>, price: number | string) {
    const signer = await locklift.keystore.getSigner("0");
    await pair.methods
        .setReserves({
            // 1 eth and {price}$ in reserves
            // tokens in pairs have 9 decimals
            newReserves: [10 ** 9, price],
        })
        .sendExternal({ publicKey: signer?.publicKey as string });
}
export async function getOpenPositionInfo(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number,
) {
    const initialPrice = Number(await getPrice(pair));
    const market = (await vault.contract.methods.getMarket({ marketIdx: market_idx, answerId: 0 }).call())._market;

    const position = collateral * (leverage / 1000000);
    const position_in_asset = (position * PRICE_DECIMALS) / initialPrice;

    let new_noi;
    if (pos_type === 0) {
        const new_longs_total = bn(market.totalLongsAsset).plus(position_in_asset / 2);
        new_noi = new_longs_total.minus(bn(market.totalShortsAsset));
    } else {
        const new_shorts_total = bn(market.totalShortsAsset).plus(position_in_asset / 2);
        new_noi = new_shorts_total.minus(bn(market.totalLongsAsset));
    }
    new_noi = new_noi.lt(0) ? bn(0) : new_noi;
    const dynamic_spread = new_noi.times(market.fees.baseDynamicSpreadRate).idiv(market.depthAsset);
    const totalSpread = bn(market.fees.baseSpreadRate).plus(dynamic_spread);

    const price_multiplier = pos_type == 0 ? PERCENT_100.plus(totalSpread) : PERCENT_100.minus(totalSpread);
    return {
        expectedPrice: price_multiplier.times(initialPrice).idiv(PERCENT_100),
        position,
        market,
        initialPrice,
        totalSpread,
    };
}
export async function openMarketOrder({
    marketIdx,
    vault,
    user,
    userWallet,
    collateral,
    leverage,
    referrer = zeroAddress,
    pair,
    posType,
}: {
    vault: GravixVault;
    pair: Contract<PairMockAbi>;
    user: Account;
    userWallet: TokenWallet;
    marketIdx: number;
    posType: 0 | 1;
    collateral: number;
    leverage: number;
    referrer?: Address;
}) {
    const { expectedPrice } = await getOpenPositionInfo(
        vault,
        pair,
        user,
        userWallet,
        marketIdx,
        posType,
        collateral,
        leverage,
    );

    return vault.openMarketPosition(
        userWallet,
        collateral,
        marketIdx,
        posType,
        leverage,
        expectedPrice.toString(),
        0,
        referrer,
        getRandomNonce(),
    );
}
export async function openMarketWithTestsOrder(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number,
    referrer = zeroAddress,
): Promise<number> {
    const { position, expectedPrice, market, initialPrice, totalSpread } = await getOpenPositionInfo(
        vault,
        pair,
        user,
        user_wallet,
        market_idx,
        pos_type,
        collateral,
        leverage,
    );
    debugger;
    const res = (
        await vault.contract.methods
            .checkPositionAllowed({
                marketIdx: market_idx,
                leverage: leverage,
                collateral: collateral,
                positionType: pos_type,
                assetPrice: expectedPrice.toString(),
            })
            .call()
    ).value0;
    expect(res.toString()).to.be.eq("0");

    const callId = getRandomNonce();
    const details_prev = await vault.details();
    const { traceTree } = await locklift.tracing.trace(
        vault.openMarketPosition(
            user_wallet,
            collateral,
            market_idx,
            pos_type,
            leverage,
            expectedPrice.toString(),
            0,
            referrer,
            callId,
        ),
        { allowedCodes: { compute: [null] }, raise: false },
    );
    await traceTree?.beautyPrint();
    debugger;
    const account = await vault.account(user);
    // @ts-ignore
    const [pos_key, pos] = (await account.positions()).pop();

    let open_fee_expected = bn(position).times(market.fees.openFeeRate).idiv(PERCENT_100);

    expect(traceTree)
        .to.emit("MarketOrder")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            collateral: collateral.toString(),
            expectedPrice: expectedPrice.toFixed(),
            leverage: leverage.toString(),
            positionType: pos_type.toString(),
            maxSlippageRate: "0",
            marketIdx: market_idx.toString(),
        })
        .and.emit("MarketOrderExecution")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            position: {
                positionType: pos_type.toString(),
                openPrice: expectedPrice.toFixed(),
                openFee: open_fee_expected.toFixed(),
            },
        });

    const event = await vault.getEvent("MarketOrderExecution");
    const details = await vault.details();
    const acc_details = await account.contract.methods.getDetails({ answerId: 0 }).call();
    const col_up = bn(collateral).minus(open_fee_expected);

    let pool_increase = open_fee_expected;
    if (!acc_details._referrer.equals(zeroAddress)) {
        pool_increase = pool_increase.minus(open_fee_expected.idiv(10));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._referrer.toString(),
                amount: open_fee_expected.idiv(10).toFixed(),
            });
    }
    if (!acc_details._grandReferrer.equals(zeroAddress)) {
        pool_increase = pool_increase.minus(open_fee_expected.idiv(100));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._grandReferrer.toString(),
                amount: open_fee_expected.idiv(100).toFixed(),
            });
    }

    expect(details._collateralReserve).to.be.eq(bn(details_prev._collateralReserve).plus(col_up).toFixed());
    expect(details._poolAssets.balance).to.be.eq(bn(details_prev._poolAssets.balance).plus(pool_increase).toFixed());

    const pos_view = (
        await account.contract.methods
            .getPositionView({
                answerId: 0,
                input: {
                    positionKey: pos_key,
                    assetPrice: initialPrice,
                    funding: {
                        accLongUSDFundingPerShare: 0,
                        accShortUSDFundingPerShare: 0,
                    },
                },
            })
            .call()
    ).positionView;

    const leveraged_usd = bn(pos_view.position.initialCollateral)
        .minus(pos_view.position.openFee)
        .times(pos_view.position.leverage)
        .idiv(1000000);

    const time_passed = bn(pos_view.viewTime).minus(pos_view.position.createdAt);
    const borrow_fee = time_passed
        .times(pos_view.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100);

    const position_up = col_up.times(leverage).idiv(1000000);
    const liq_price_dist = expectedPrice
        .times(col_up.times(0.9).integerValue(BigNumber.ROUND_FLOOR).minus(borrow_fee).minus(pos_view.fundingFee))
        .div(col_up)
        .times(1000000)
        .div(leverage)
        .integerValue(BigNumber.ROUND_FLOOR);

    let liq_price = pos_type == 0 ? expectedPrice.minus(liq_price_dist) : expectedPrice.plus(liq_price_dist);
    liq_price =
        pos_type == 0
            ? liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate))
            : liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));
    liq_price = liq_price.isNegative() ? bn(0) : liq_price;

    expect(pos_view.liquidationPrice.toString()).to.be.eq(liq_price.toString());

    logger.log(
        `Open ${ptype[pos_type]} position,`,
        `market price - ${toUSD(initialPrice / 100)}$,`,
        // @ts-ignore
        `open price - ${toUSD(expectedPrice / 100)}\$,`,
        // @ts-ignore
        `liquidation price - ${toUSD(liq_price / 100)}\$,`,
        `spread - ${totalSpread.div(10 ** 10).toFixed(3)}\%,`,
        `collateral - ${toUSD(col_up)}\$,`,
        `position size - ${toUSD(position_up)}\$,`,
        `open fee - ${toUSD(open_fee_expected)}\$`,
    );

    return pos_key;
}

export async function openLimitWithTestsOrder({
    user,
    userWallet,
    marketIdx,
    posType,
    collateral,
    leverage,
    referrer = zeroAddress,
    limitType,
    pair,
    vault,
    finishPrice,
}: {
    vault: GravixVault;
    pair: Contract<PairMockAbi>;
    user: Account;
    userWallet: TokenWallet;
    marketIdx: number;
    posType: PosType;
    limitType: LimitType;
    collateral: number;
    leverage: number;
    referrer: Address;
    finishPrice: number;
}): Promise<number> {
    const { position, market, initialPrice, totalSpread } = await getOpenPositionInfo(
        vault,
        pair,
        user,
        userWallet,
        marketIdx,
        posType,
        collateral,
        leverage,
    );

    // const res = (
    //     await vault.contract.methods
    //         .checkPositionAllowed({
    //             marketIdx: marketIdx,
    //             leverage: leverage,
    //             collateral: collateral,
    //             positionType: posType,
    //             assetPrice: expectedPrice.toString(),
    //         })
    //         .call()
    // ).value0;
    // expect(res.toString()).to.be.eq("0");

    const callId = getRandomNonce();
    const details_prev = await vault.details();
    // const targetPrice = getPriceForLimitOrder({
    //     limitType,
    //     currentPrice: initialPrice,
    //     posType,
    //     isWrong: false,
    // });
    const { traceTree } = await locklift.tracing.trace(
        vault.openLimitPosition({
            limitType,
            callId,
            amount: collateral,
            targetPrice: finishPrice * 100,
            referrer,
            leverage,
            positionType: posType,
            marketIdx: marketIdx,
            fromWallet: userWallet,
        }),
        { allowedCodes: { compute: [null] }, raise: false },
    );
    await traceTree?.beautyPrint();

    const account = await vault.account(user);
    // @ts-ignore
    // const [pos_key, pos] = (await account.positions()).pop();

    let open_fee_expected = bn(position).times(market.fees.openFeeRate).idiv(PERCENT_100);

    expect(traceTree)
        .to.emit("LimitOrder")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            collateral: collateral.toString(),
            targetPrice: (finishPrice * 100).toString(),
            leverage: leverage.toString(),
            positionType: posType.toString(),
            limitType: limitType.toString(),
            marketIdx: marketIdx.toString(),
        });
    const { targetPrice: triggerPrice, positionKey } = traceTree?.findEventsForContract({
        contract: vault.contract,
        name: "LimitOrder" as const,
    })[0]!;

    await setPrice(pair, finishPrice.toString());
    {
        const { traceTree } = await locklift.tracing.trace(
            vault.contract.methods
                .limitBot_executeLimitOrders({
                    limitOrdersMap: [
                        [
                            marketIdx,
                            {
                                price: empty_price,
                                positions: [
                                    {
                                        positionKey,
                                        collateral: collateral,
                                        positionType: posType,
                                        marketIdx: marketIdx,
                                        leverage: leverage,
                                        user: user.address,
                                    },
                                ],
                            },
                        ],
                    ],
                    meta: {
                        callId: callId,
                        nonce: 0,
                        sendGasTo: user.address,
                    },
                })
                .send({
                    from: user.address,
                    amount: toNano(10),
                }),
        );
        await traceTree?.beautyPrint();
    }
    const positions = await account.positions();
    const expectedPrice = bn(positions[0][1].openPrice);

    debugger;
    const event = await vault.getEvent("MarketOrderExecution");
    const details = await vault.details();
    const acc_details = await account.contract.methods.getDetails({ answerId: 0 }).call();
    const col_up = bn(collateral).minus(open_fee_expected);

    let pool_increase = open_fee_expected;
    if (!acc_details._referrer.equals(zeroAddress)) {
        pool_increase = pool_increase.minus(open_fee_expected.idiv(10));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._referrer.toString(),
                amount: open_fee_expected.idiv(10).toFixed(),
            });
    }
    if (!acc_details._grandReferrer.equals(zeroAddress)) {
        pool_increase = pool_increase.minus(open_fee_expected.idiv(100));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._grandReferrer.toString(),
                amount: open_fee_expected.idiv(100).toFixed(),
            });
    }

    expect(details._collateralReserve).to.be.eq(bn(details_prev._collateralReserve).plus(col_up).toFixed());
    expect(details._poolAssets.balance).to.be.eq(bn(details_prev._poolAssets.balance).plus(pool_increase).toFixed());

    const pos_view = (
        await account.contract.methods
            .getPositionView({
                answerId: 0,
                input: {
                    positionKey: positionKey,
                    assetPrice: finishPrice * 100,
                    funding: {
                        accLongUSDFundingPerShare: 0,
                        accShortUSDFundingPerShare: 0,
                    },
                },
            })
            .call()
    ).positionView;
    debugger;
    const leveraged_usd = bn(pos_view.position.initialCollateral)
        .minus(pos_view.position.openFee)
        .times(pos_view.position.leverage)
        .idiv(1000000);

    const time_passed = bn(pos_view.viewTime).minus(pos_view.position.createdAt);
    const borrow_fee = time_passed
        .times(pos_view.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100);

    const position_up = col_up.times(leverage).idiv(1000000);
    const liq_price_dist = expectedPrice
        .times(col_up.times(0.9).integerValue(BigNumber.ROUND_FLOOR).minus(borrow_fee).minus(pos_view.fundingFee))
        .div(col_up)
        .times(1000000)
        .div(leverage)
        .integerValue(BigNumber.ROUND_FLOOR);

    let liq_price = posType == 0 ? expectedPrice.minus(liq_price_dist) : expectedPrice.plus(liq_price_dist);
    liq_price =
        posType == 0
            ? liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate))
            : liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));
    liq_price = liq_price.isNegative() ? bn(0) : liq_price;

    expect(pos_view.liquidationPrice.toString()).to.be.eq(liq_price.toString());

    logger.log(
        `Open ${ptype[posType]} position,`,
        `market price - ${toUSD(initialPrice / 100)}$,`,
        // @ts-ignore
        `open price - ${toUSD(expectedPrice / 100)}\$,`,
        // @ts-ignore
        `liquidation price - ${toUSD(liq_price / 100)}\$,`,
        `spread - ${totalSpread.div(10 ** 10).toFixed(3)}\%,`,
        `collateral - ${toUSD(col_up)}\$,`,
        `position size - ${toUSD(position_up)}\$,`,
        `open fee - ${toUSD(open_fee_expected)}\$`,
    );

    return 1;
}

export async function closeOrder(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    pos_key: number,
    referrer = zeroAddress,
) {
    const finish_price = Number(await getPrice(pair));
    const account = await vault.account(user);

    const pos_view1 = (
        await account.contract.methods
            .getPositionView({
                answerId: 0,
                input: {
                    positionKey: pos_key,
                    assetPrice: finish_price,
                    funding: {
                        accLongUSDFundingPerShare: 0,
                        accShortUSDFundingPerShare: 0,
                    },
                },
            })
            .call()
    ).positionView;

    // @ts-ignore
    const pos_type: 0 | 1 = Number(pos_view1.position.positionType);
    const market = (
        await vault.contract.methods
            .getMarket({
                marketIdx: pos_view1.position.marketIdx,
                answerId: 0,
            })
            .call()
    )._market;

    // const details_prev = await vault.details();
    const callId = getRandomNonce();
    const { traceTree: traceTree1 } = await locklift.tracing.trace(
        vault.closePosition(user, pos_key, pos_view1.position.marketIdx, callId),
    );

    const event = await vault.getEvent("ClosePosition");
    // @ts-ignore
    const pos_view2 = event.positionView;

    const price_multiplier1 =
        pos_type === 0 ? PERCENT_100.minus(market.fees.baseSpreadRate) : PERCENT_100.plus(market.fees.baseSpreadRate);
    const expected_close_price = price_multiplier1.times(finish_price).idiv(PERCENT_100);
    const leveraged_usd = bn(pos_view2.position.initialCollateral)
        .minus(pos_view2.position.openFee)
        .times(pos_view2.position.leverage)
        .idiv(1000000);
    // const leveraged_asset = leveraged_usd.times(TOKEN_DECIMALS).idiv(pos_view2.position.openPrice);

    // console.log(event);

    const time_passed = bn(pos_view2.viewTime).minus(pos_view2.position.createdAt);
    const borrow_fee = time_passed
        .times(pos_view2.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100);

    expect(borrow_fee.toFixed()).to.be.eq(pos_view2.borrowFee);

    const col_up = bn(pos_view2.position.initialCollateral).minus(pos_view2.position.openFee);

    let expected_pnl = expected_close_price
        .times(SCALING_FACTOR)
        .idiv(pos_view2.position.openPrice)
        .minus(SCALING_FACTOR)
        .times(pos_type == 0 ? 1 : -1)
        .times(leveraged_usd)
        .div(SCALING_FACTOR)
        .integerValue(BigNumber.ROUND_FLOOR); // js bignumber cant floor in idiv correctly ;/

    const liq_price_dist = bn(pos_view2.position.openPrice)
        .times(col_up.times(0.9).integerValue(BigNumber.ROUND_FLOOR).minus(borrow_fee).minus(pos_view2.fundingFee))
        .idiv(leveraged_usd)
        .integerValue(BigNumber.ROUND_FLOOR);

    let liq_price =
        pos_type == 0
            ? bn(pos_view2.position.openPrice).minus(liq_price_dist)
            : bn(pos_view2.position.openPrice).plus(liq_price_dist);
    liq_price =
        pos_type == 0
            ? liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate))
            : liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));

    liq_price = liq_price.isNegative() ? bn(0) : liq_price;

    let up_pos = col_up
        .times(pos_view2.position.leverage)
        .idiv(1000000)
        .plus(expected_pnl)
        .minus(borrow_fee)
        .minus(pos_view2.fundingFee);
    // console.log(expected_pnl, borrow_fee);
    const expected_close_fee = up_pos.times(pos_view2.position.closeFeeRate).idiv(PERCENT_100);

    expect(liq_price.toFixed()).to.be.eq(pos_view2.liquidationPrice);

    expect(pos_view2.closePrice.toString()).to.be.eq(expected_close_price.toString());
    expect(pos_view2.pnl.toString()).to.be.eq(expected_pnl.toString());
    expect(pos_view2.liquidate).to.be.false;

    expect(traceTree1)
        .to.emit("ClosePosition")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            positionView: {
                closePrice: expected_close_price.toFixed(),
                fundingFee: pos_view2.fundingFee,
                borrowFee: borrow_fee.toFixed(),
                closeFee: expected_close_fee.toFixed(),
                pnl: expected_pnl.toFixed(),
            },
        });

    const max_pnl_rate = (await vault.contract.methods.getDetails({ answerId: 0 }).call())._maxPnlRate;
    const max_pnl = col_up.times(max_pnl_rate).idiv(PERCENT_100);

    const net_pnl = expected_pnl.minus(expected_close_fee);
    const percent_diff = net_pnl
        .div(bn(pos_view1.position.initialCollateral).minus(pos_view1.position.openFee))
        .times(1000000);

    const limited_pnl = max_pnl.gt(expected_pnl) ? expected_pnl : max_pnl;
    const pnl_with_fees = limited_pnl.minus(borrow_fee).minus(pos_view2.fundingFee);
    const user_payout = pnl_with_fees.minus(expected_close_fee).plus(col_up);

    expect(traceTree1).to.call("transfer").withNamedArgs({
        recipient: user.address.toString(),
        amount: user_payout.toString(),
    });

    const acc_details = await account.contract.methods.getDetails({ answerId: 0 }).call();

    if (!acc_details._referrer.equals(zeroAddress)) {
        expect(traceTree1)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._referrer.toString(),
                amount: expected_close_fee.idiv(10).toFixed(),
            });

        if (pnl_with_fees.lte(0)) {
            expect(traceTree1)
                .to.emit("ReferralPayment")
                .withNamedArgs({
                    callId: callId.toFixed(),
                    referral: user.address,
                    referrer: acc_details._referrer.toString(),
                    amount: pnl_with_fees.abs().idiv(100).toFixed(),
                });
        }
    }
    if (!acc_details._grandReferrer.equals(zeroAddress)) {
        expect(traceTree1)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: acc_details._grandReferrer.toString(),
                amount: expected_close_fee.idiv(100).toFixed(),
            });

        if (pnl_with_fees.lte(0)) {
            expect(traceTree1)
                .to.emit("ReferralPayment")
                .withNamedArgs({
                    callId: callId.toFixed(),
                    referral: user.address,
                    referrer: acc_details._grandReferrer.toString(),
                    amount: pnl_with_fees.abs().idiv(1000).toFixed(),
                });
        }
    }

    // const details1 = await vault.details();
    // expect(details1._totalNOI.toString()).to.be.eq('0');
    logger.log(
        `Close ${ptype[pos_type]} position, market price - ${toUSD(finish_price / 100)}$,`,
        // @ts-ignore
        `close price - ${toUSD(expected_close_price / 100)}\$,`,
        `net pnl ${toUSD(net_pnl)}\$,`,
        `(${percent_diff.toFixed(2)}%),`,
        `close fee - ${toUSD(expected_close_fee)}\$`,
        `funding fee - ${toUSD(bn(pos_view2.fundingFee))}\$`,
    );

    return pos_view2;
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
    ttl = 0,
    referrer = zeroAddress,
) {
    await setPrice(pair, initial_price);
    // OPEN POSITION
    const pos_key = await openMarketWithTestsOrder(
        vault,
        pair,
        user,
        user_wallet,
        market_idx,
        pos_type,
        collateral,
        leverage,
        referrer,
    );
    if (ttl > 0) {
        await tryIncreaseTime(ttl);
    }

    // CLOSE POSITION
    await setPrice(pair, finish_price);
    await closeOrder(vault, pair, user, user_wallet, pos_key, referrer);
}

export const testLimitPosition = async ({
    ttl = 0,
    referrer = zeroAddress,
    user,
    userWallet,
    collateral,
    leverage,
    initialPrice,
    finishPrice,
    pair,
    marketIdx,
    posType,
    vault,
    limitType,
}: {
    vault: GravixVault;
    pair: Contract<PairMockAbi>;
    user: Account;
    userWallet: TokenWallet;
    marketIdx: number;
    posType: PosType;
    limitType: LimitType;
    collateral: number;
    leverage: number;
    initialPrice: number;
    finishPrice: number;
    ttl?: number;
    referrer?: Address;
}) => {
    const market = (
        await vault.contract.methods
            .getMarket({
                marketIdx,
                answerId: 0,
            })
            .call()
    )._market;
    await setPrice(pair, initialPrice);
    const key = await openLimitWithTestsOrder({
        user,
        vault,
        pair,
        referrer,
        leverage,
        collateral,
        posType,
        marketIdx,
        userWallet,
        limitType,
        finishPrice,
    });
};

export async function testPositionFunding(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number,
    initial_price: number,
    ttl = 0,
    referrer = zeroAddress,
) {
    const market = (
        await vault.contract.methods
            .getMarket({
                marketIdx: market_idx,
                answerId: 0,
            })
            .call()
    )._market;
    await setPrice(pair, initial_price);
    // market has 15k$ depth, open pos on 10k$
    const pos_key = await openMarketWithTestsOrder(
        vault,
        pair,
        user,
        user_wallet,
        market_idx,
        pos_type,
        collateral,
        leverage,
        referrer,
    );

    const market_0 = (await vault.contract.methods.getMarket({ marketIdx: 2, answerId: 0 }).call())._market;
    // save funding time
    // 12 hours
    await tryIncreaseTime(ttl);
    const rates = await vault.contract.methods.getFundingRates({ marketIdx: 2 }).call();
    const pos_view = await closeOrder(vault, pair, user, user_wallet, pos_key, referrer);
    // calculate based on time + noi and check if correct
    const market_1 = (await vault.contract.methods.getMarket({ marketIdx: 2, answerId: 0 }).call())._market;

    // check rates
    const noi = bn(market_0.totalLongsAsset).minus(market_0.totalShortsAsset).abs();
    const funding_rate = bn(market.fees.fundingBaseRatePerHour)
        .times(noi.times(SCALING_FACTOR).idiv(market_0.depthAsset))
        .idiv(SCALING_FACTOR);

    let long_rate: BigNumber = bn(0);
    let short_rate: BigNumber = bn(0);

    if (bn(market_0.totalLongsAsset).isGreaterThanOrEqualTo(market_0.totalShortsAsset)) {
        long_rate = funding_rate;
        if (bn(market_0.totalShortsAsset).isGreaterThan(0)) {
            short_rate = long_rate.times(-1).times(market_0.totalLongsAsset).idiv(market_0.totalShortsAsset);
        }
    } else {
        short_rate = funding_rate;
        if (bn(market_0.totalLongsAsset).isGreaterThan(0)) {
            long_rate = short_rate.times(-1).times(market_0.totalShortsAsset).idiv(market_0.totalLongsAsset);
        }
    }

    expect(rates.longRatePerHour).to.be.eq(long_rate.toFixed());
    expect(rates.shortRatePerHour).to.be.eq(short_rate.toFixed());

    let long_accFundingPerShare = bn(0);
    let short_accFundingPerShare = bn(0);

    // check abs values
    if (!long_rate.isZero()) {
        const long_funding_asset = long_rate
            .times(market_0.totalLongsAsset)
            .times(SCALING_FACTOR)
            .div(PERCENT_100)
            .integerValue(BigNumber.ROUND_FLOOR)
            .times(bn(market_1.lastFundingUpdateTime).minus(market_0.lastFundingUpdateTime))
            .div(3600)
            .integerValue(BigNumber.ROUND_FLOOR);

        const long_funding_usd = long_funding_asset
            .times(initial_price * 100)
            .div(PRICE_DECIMALS)
            .integerValue(BigNumber.ROUND_FLOOR);

        long_accFundingPerShare = long_funding_usd.div(market_0.totalLongsAsset).integerValue(BigNumber.ROUND_FLOOR);
    }

    if (!short_rate.isZero()) {
        const short_funding_asset = short_rate
            .times(market_0.totalShortsAsset)
            .times(SCALING_FACTOR)
            .div(PERCENT_100)
            .integerValue(BigNumber.ROUND_FLOOR)
            .times(bn(market_1.lastFundingUpdateTime).minus(market_0.lastFundingUpdateTime))
            .div(3600)
            .integerValue(BigNumber.ROUND_FLOOR);

        const short_funding_usd = short_funding_asset
            .times(initial_price * 100)
            .div(PRICE_DECIMALS)
            .integerValue(BigNumber.ROUND_FLOOR);

        short_accFundingPerShare = short_funding_usd.div(market_0.totalShortsAsset).integerValue(BigNumber.ROUND_FLOOR);
    }

    const cur_short_acc = bn(market_0.funding.accShortUSDFundingPerShare).plus(short_accFundingPerShare);
    const cur_long_acc = bn(market_0.funding.accLongUSDFundingPerShare).plus(long_accFundingPerShare);

    expect(market_1.funding.accLongUSDFundingPerShare).to.be.eq(cur_long_acc.toFixed());
    expect(market_1.funding.accShortUSDFundingPerShare).to.be.eq(cur_short_acc.toFixed());
}
