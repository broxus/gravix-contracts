import { Address, Contract, fromNano, getRandomNonce, toNano, zeroAddress } from "locklift";
import { Account } from "locklift/everscale-client";
import { GravixVault } from "./wrappers/vault";
import BigNumber from "bignumber.js";
import { GravixVaultAbi, PairMockAbi } from "../../build/factorySource";
import { bn, getPriceForLimitOrder, toUSD, tryIncreaseTime } from "./common";
import { TokenWallet } from "./wrappers/token_wallet";
import { LimitOrderSate, LimitType, PosType } from "./constants";
import { GravixAccount } from "./wrappers/vault_acc";
import { ViewTracingTree } from "locklift/internal/tracing/viewTraceTree/viewTracingTree";

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

export async function getOpenLimitPositionInfo(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    posType: 0 | 1,
    collateral: number,
    leverage: number,
    triggerPrice: string | number,
) {
    const initialPrice = Number(await getPrice(pair));
    const market = (await vault.contract.methods.getMarket({ marketIdx: market_idx, answerId: 0 }).call())._market;

    const position = collateral * (leverage / 1000000);

    const totalSpread = bn(market.fees.baseSpreadRate);
    const price_multiplier = posType == 0 ? PERCENT_100.plus(totalSpread) : PERCENT_100.minus(totalSpread);

    return {
        expectedOpenPrice: price_multiplier.times(triggerPrice).idiv(PERCENT_100),
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
export async function openMarketOrderWithTests(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    market_idx: number,
    pos_type: 0 | 1,
    collateral: number,
    leverage: number,
    referrer = zeroAddress,
    stopLooseTriggerPrice = 0,
    takeProfitTriggerPrice = 0,
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
            stopLooseTriggerPrice * 100,
            takeProfitTriggerPrice * 100,
        ),
        { allowedCodes: { compute: [null] } },
    );
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
                stopLoss: stopLooseTriggerPrice
                    ? {
                          triggerPrice: (stopLooseTriggerPrice * 100).toString(),
                      }
                    : null,
                takeProfit: takeProfitTriggerPrice ? { triggerPrice: (takeProfitTriggerPrice * 100).toString() } : null,
            },
        });

    const { colUp, posUp, liqPrice } = await checkOpenedPositionMath({
        market,
        posType: pos_type,
        collateral,
        leverage,
        expectedOpenPrice: expectedPrice,
        assetPrice: initialPrice,
        openFeeExpected: open_fee_expected,
        openPositionTraceTree: traceTree,
        positionKey: pos_key,
        callId,
        user,
        vaultPrevDetails: details_prev,
        vault,
    });
    logger.log(
        `Open ${ptype[pos_type]} position,`,
        `market price - ${toUSD(initialPrice / 100)}$,`,
        // @ts-ignore
        `open price - ${toUSD(expectedPrice / 100)}\$,`,
        // @ts-ignore
        `liquidation price - ${toUSD(liqPrice / 100)}\$,`,
        `spread - ${totalSpread.div(10 ** 10).toFixed(3)}\%,`,
        `collateral - ${toUSD(colUp)}\$,`,
        `position size - ${toUSD(posUp)}\$,`,
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
    triggerPrice,
    takeProfitTriggerPrice = 0,
    stopLossTriggerPrice = 0,
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
    triggerPrice: number;
    stopLossTriggerPrice?: number;
    takeProfitTriggerPrice?: number;
}): Promise<number> {
    const initialPrice = Number(await getPrice(pair));
    const market = (await vault.contract.methods.getMarket({ marketIdx, answerId: 0 }).call())._market;

    const position = collateral * (leverage / 1000000);

    const totalSpread = bn(market.fees.baseSpreadRate);
    const price_multiplier = posType == 0 ? PERCENT_100.plus(totalSpread) : PERCENT_100.minus(totalSpread);
    const expectedOpenPrice = price_multiplier.times(triggerPrice * 100).idiv(PERCENT_100);

    const res = (
        await vault.contract.methods
            .checkPositionAllowed({
                marketIdx: marketIdx,
                leverage: leverage,
                collateral: collateral,
                positionType: posType,
                assetPrice: expectedOpenPrice.toString(),
            })
            .call()
    ).value0;
    expect(res.toString()).to.be.eq("0");

    const callId = getRandomNonce();
    const details_prev = await vault.details();

    const { traceTree: openLimitOrderTraceTree } = await locklift.tracing.trace(
        vault.openLimitPosition({
            limitType,
            callId,
            amount: collateral,
            triggerPrice: triggerPrice * 100,
            referrer,
            leverage,
            positionType: posType,
            marketIdx: marketIdx,
            fromWallet: userWallet,
            stopLossTriggerPrice: stopLossTriggerPrice * 100,
            takeProfitTriggerPrice: takeProfitTriggerPrice * 100,
        }),
        { allowedCodes: { compute: [null] } },
    );
    let openFeeExpected = bn(position).times(market.fees.openFeeRate).idiv(PERCENT_100);
    const [{ orderKey: pendingLimitOrderPosKey }] = openLimitOrderTraceTree?.findEventsForContract({
        contract: vault.contract,
        name: "PendingLimitOrderCreated" as const,
    })!;
    const [{ orderKey }] = openLimitOrderTraceTree?.findEventsForContract({
        contract: vault.contract,
        name: "LimitOrder" as const,
    })!;
    if (!referrer.equals(zeroAddress)) {
        expect(openLimitOrderTraceTree)
            .to.call("getReferrer", await vault.getAccountAddress(referrer))
            .and.call("process_getReferrer", await vault.getAccountAddress(user));
    }
    expect(openLimitOrderTraceTree)
        .to.emit("PendingLimitOrderCreated")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            order: {
                marketIdx: marketIdx.toString(),
                positionType: posType.toString(),
                collateral: collateral.toString(),
                triggerPrice: (triggerPrice * 100).toString(),
                orderType: limitType.toString(),
            },
            orderKey: pendingLimitOrderPosKey,
        })
        .to.emit("LimitOrder")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            orderKey: pendingLimitOrderPosKey,
            order: {
                collateral: collateral.toString(),
                triggerPrice: (triggerPrice * 100).toString(),
                leverage: leverage.toString(),
                positionType: posType.toString(),
                orderType: limitType.toString(),
                marketIdx: marketIdx.toString(),
            },
        });
    const { limitOrders } = await vault.account(user).then(acc => acc.orders());
    const pendingLimitOrder = limitOrders.find(([posKey]) => posKey === pendingLimitOrderPosKey)!;

    expect(pendingLimitOrder[1].state).to.be.eq(LimitOrderSate.Executed);
    await setPrice(pair, triggerPrice.toString());
    const { traceTree: executeLimitOrderTraceTree } = await locklift.tracing.trace(
        vault.contract.methods
            .executeLimitOrders({
                limitOrdersMap: [
                    [
                        marketIdx,
                        {
                            price: empty_price,
                            orders: [
                                {
                                    orderKey: pendingLimitOrderPosKey,
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
                from: vault.limitBot,
                amount: toNano(10),
            }),
    );

    const { colUp, posUp, liqPrice } = await checkOpenedPositionMath({
        market,
        posType,
        collateral,
        leverage,
        expectedOpenPrice,
        assetPrice: triggerPrice * 100,
        openFeeExpected,
        openPositionTraceTree: executeLimitOrderTraceTree,
        positionKey: orderKey,
        callId,
        user,
        vaultPrevDetails: details_prev,
        vault,
    });

    logger.log(
        `Open ${ptype[posType]} position,`,
        `market price - ${toUSD(initialPrice / 100)}$,`,
        // @ts-ignore
        `open price - ${toUSD(expectedOpenPrice / 100)}\$,`,
        // @ts-ignore
        `liquidation price - ${toUSD(liqPrice / 100)}\$,`,
        `spread - ${totalSpread.div(10 ** 10).toFixed(3)}\%,`,
        `collateral - ${toUSD(colUp)}\$,`,
        `position size - ${toUSD(posUp)}\$,`,
        `open fee - ${toUSD(openFeeExpected)}\$`,
    );

    return Number(orderKey);
}
const checkOpenedPositionMath = async ({
    vault,
    collateral,
    openFeeExpected,
    openPositionTraceTree: traceTree,
    callId,
    user,
    vaultPrevDetails,
    positionKey,
    assetPrice,
    leverage,
    expectedOpenPrice,
    posType,
    market,
}: {
    vault: GravixVault;
    user: Account;
    collateral: number;
    openFeeExpected: BigNumber;
    openPositionTraceTree: ViewTracingTree | undefined;
    callId: number;
    vaultPrevDetails: ReturnType<GravixVault["details"]> extends Promise<infer T> ? T : never;
    positionKey: string;
    assetPrice: number;
    leverage: number;
    expectedOpenPrice: BigNumber;
    posType: 0 | 1;
    market: (ReturnType<ReturnType<Contract<GravixVaultAbi>["methods"]["getMarket"]>["call"]> extends Promise<infer T>
        ? T
        : never)["_market"];
}): Promise<{ colUp: BigNumber; posUp: BigNumber; liqPrice: number }> => {
    const account = await vault.account(user);
    const details = await vault.details();
    const accDetails = await account.contract.methods.getDetails({ answerId: 0 }).call();
    const colUp = bn(collateral).minus(openFeeExpected);

    let poolIncrease = openFeeExpected;
    if (!accDetails._referrer.equals(zeroAddress)) {
        poolIncrease = poolIncrease.minus(openFeeExpected.idiv(10));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: accDetails._referrer.toString(),
                amount: openFeeExpected.idiv(10).toFixed(),
            });
    }
    if (!accDetails._grandReferrer.equals(zeroAddress)) {
        poolIncrease = poolIncrease.minus(openFeeExpected.idiv(100));

        expect(traceTree)
            .to.emit("ReferralPayment")
            .withNamedArgs({
                callId: callId.toFixed(),
                referral: user.address,
                referrer: accDetails._grandReferrer.toString(),
                amount: openFeeExpected.idiv(100).toFixed(),
            });
    }

    expect(details._collateralReserve).to.be.eq(bn(vaultPrevDetails._collateralReserve).plus(colUp).toFixed());
    expect(details._poolAssets.balance).to.be.eq(bn(vaultPrevDetails._poolAssets.balance).plus(poolIncrease).toFixed());

    const pos_view = (
        await account.contract.methods
            .getPositionView({
                answerId: 0,
                input: {
                    positionKey: positionKey,
                    assetPrice: assetPrice,
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

    const posUp = colUp.times(leverage).idiv(1000000);
    const liq_price_dist = expectedOpenPrice
        .times(colUp.times(0.9).integerValue(BigNumber.ROUND_FLOOR).minus(borrow_fee).minus(pos_view.fundingFee))
        .div(colUp)
        .times(1000000)
        .div(leverage)
        .integerValue(BigNumber.ROUND_FLOOR);

    let liqPrice = posType == 0 ? expectedOpenPrice.minus(liq_price_dist) : expectedOpenPrice.plus(liq_price_dist);
    liqPrice =
        posType == 0
            ? liqPrice.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate))
            : liqPrice.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));
    liqPrice = liqPrice.isNegative() ? bn(0) : liqPrice;

    expect(pos_view.liquidationPrice.toString()).to.be.eq(liqPrice.toString());
    return {
        colUp,
        posUp,
        liqPrice: liqPrice.toNumber(),
    };
};

export const closeOrderWithTraceTree = async ({
    user,
    userWallet,
    pos_key,
    referrer = zeroAddress,
    pair,
    vault,
    stopOrderConfig,
}: {
    vault: GravixVault;
    pair: Contract<PairMockAbi>;
    user: Account;
    userWallet: TokenWallet;
    pos_key: number;
    referrer: Address;
    stopOrderConfig?: {
        stopPositionType: 0 | 1;
    };
}) => {
    const currentPrice = Number(await getPrice(pair));
    const account = await vault.account(user);

    const posView1 = (
        await account.contract.methods
            .getPositionView({
                answerId: 0,
                input: {
                    positionKey: pos_key,
                    assetPrice: currentPrice,
                    funding: {
                        accLongUSDFundingPerShare: 0,
                        accShortUSDFundingPerShare: 0,
                    },
                },
            })
            .call()
    ).positionView;

    // @ts-ignore
    const pos_type: 0 | 1 = Number(posView1.position.positionType);
    const market = (
        await vault.contract.methods
            .getMarket({
                marketIdx: posView1.position.marketIdx,
                answerId: 0,
            })
            .call()
    )._market;

    // const details_prev = await vault.details();
    const callId = getRandomNonce();
    const { traceTree: traceTree1 } = await locklift.tracing.trace(
        !stopOrderConfig
            ? vault.closePosition(user, pos_key, posView1.position.marketIdx, callId)
            : vault.stopPositions({
                  callId,
                  stopPositionsConfig: [
                      [
                          posView1.position.marketIdx,
                          {
                              price: empty_price,
                              positions: [
                                  {
                                      positionKey: pos_key,
                                      triggerPositionType: stopOrderConfig.stopPositionType,
                                      user: user.address,
                                  },
                              ],
                          },
                      ],
                  ],
              }),
    );
    const event = await vault.getEvent("ClosePosition");
    // @ts-ignore
    const posView2 = event.positionView;

    const isStop = !!stopOrderConfig;
    const price_multiplier1 =
        pos_type === 0 ? PERCENT_100.minus(market.fees.baseSpreadRate) : PERCENT_100.plus(market.fees.baseSpreadRate);

    const finishPrice = isStop
        ? stopOrderConfig.stopPositionType === 1
            ? posView2.position.takeProfit.triggerPrice
            : posView2.position.stopLoss.triggerPrice
        : currentPrice;
    const expected_close_price = price_multiplier1.times(finishPrice).idiv(PERCENT_100);
    const leveraged_usd = bn(posView2.position.initialCollateral)
        .minus(posView2.position.openFee)
        .times(posView2.position.leverage)
        .idiv(1000000);
    // const leveraged_asset = leveraged_usd.times(TOKEN_DECIMALS).idiv(pos_view2.position.openPrice);

    // console.log(event);

    const time_passed = bn(posView2.viewTime).minus(posView2.position.createdAt);
    const borrow_fee = time_passed
        .times(posView2.position.borrowBaseRatePerHour)
        .idiv(3600)
        .times(leveraged_usd)
        .idiv(PERCENT_100);

    expect(borrow_fee.toFixed()).to.be.eq(posView2.borrowFee);

    const col_up = bn(posView2.position.initialCollateral).minus(posView2.position.openFee);

    let expected_pnl = expected_close_price
        .times(SCALING_FACTOR)
        .idiv(posView2.position.openPrice)
        .minus(SCALING_FACTOR)
        .times(pos_type == 0 ? 1 : -1)
        .times(leveraged_usd)
        .div(SCALING_FACTOR)
        .integerValue(BigNumber.ROUND_FLOOR); // js bignumber cant floor in idiv correctly ;/

    const liq_price_dist = bn(posView2.position.openPrice)
        .times(col_up.times(0.9).integerValue(BigNumber.ROUND_FLOOR).minus(borrow_fee).minus(posView2.fundingFee))
        .idiv(leveraged_usd)
        .integerValue(BigNumber.ROUND_FLOOR);

    let liq_price =
        pos_type == 0
            ? bn(posView2.position.openPrice).minus(liq_price_dist)
            : bn(posView2.position.openPrice).plus(liq_price_dist);
    liq_price =
        pos_type == 0
            ? liq_price.times(PERCENT_100).idiv(PERCENT_100.minus(market.fees.baseSpreadRate))
            : liq_price.times(PERCENT_100).idiv(PERCENT_100.plus(market.fees.baseSpreadRate));

    liq_price = liq_price.isNegative() ? bn(0) : liq_price;

    let up_pos = col_up
        .times(posView2.position.leverage)
        .idiv(1000000)
        .plus(expected_pnl)
        .minus(borrow_fee)
        .minus(posView2.fundingFee);
    // console.log(expected_pnl, borrow_fee);
    const expected_close_fee = up_pos.times(posView2.position.closeFeeRate).idiv(PERCENT_100);

    expect(liq_price.toFixed()).to.be.eq(posView2.liquidationPrice);

    expect(posView2.closePrice.toString()).to.be.eq(expected_close_price.toString());
    expect(posView2.pnl.toString()).to.be.eq(expected_pnl.toString());
    expect(posView2.liquidate).to.be.false;

    expect(traceTree1)
        .to.emit("ClosePosition")
        .withNamedArgs({
            callId: callId.toFixed(),
            user: user.address,
            positionView: {
                closePrice: expected_close_price.toFixed(),
                fundingFee: posView2.fundingFee,
                borrowFee: borrow_fee.toFixed(),
                closeFee: expected_close_fee.toFixed(),
                pnl: expected_pnl.toFixed(),
            },
        });

    const max_pnl_rate = (await vault.contract.methods.getDetails({ answerId: 0 }).call())._maxPnlRate;
    const max_pnl = col_up.times(max_pnl_rate).idiv(PERCENT_100);

    const net_pnl = expected_pnl.minus(expected_close_fee);
    const percent_diff = net_pnl
        .div(bn(posView1.position.initialCollateral).minus(posView1.position.openFee))
        .times(1000000);

    const limited_pnl = max_pnl.gt(expected_pnl) ? expected_pnl : max_pnl;
    const pnl_with_fees = limited_pnl.minus(borrow_fee).minus(posView2.fundingFee);
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
        `Close ${ptype[pos_type]} position, market price - ${toUSD(currentPrice / 100)}$,`,
        // @ts-ignore
        `close price - ${toUSD(expected_close_price / 100)}\$,`,
        `net pnl ${toUSD(net_pnl)}\$,`,
        `(${percent_diff.toFixed(2)}%),`,
        `close fee - ${toUSD(expected_close_fee)}\$`,
        `funding fee - ${toUSD(bn(posView2.fundingFee))}\$`,
    );

    return { posView: posView2, traceTree: traceTree1 };
};
export async function closePosition(
    vault: GravixVault,
    pair: Contract<PairMockAbi>,
    user: Account,
    user_wallet: TokenWallet,
    pos_key: number,
    referrer = zeroAddress,
    stopOrderConfig?: {
        stopPositionType: 0 | 1;
    },
) {
    const { posView } = await closeOrderWithTraceTree({
        stopOrderConfig,
        vault,
        pair,
        user,
        userWallet: user_wallet,
        pos_key,
        referrer,
    });
    return posView;
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
    const pos_key = await openMarketOrderWithTests(
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
    const { marketOrders } = await vault.account(user).then(acc => acc.orders());
    expect(marketOrders.length).to.be.eq(0);
    // CLOSE POSITION
    await setPrice(pair, finish_price);
    await closePosition(vault, pair, user, user_wallet, pos_key, referrer);
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
    triggerPrice,
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
    triggerPrice: number;
    finishPrice: number;
    ttl?: number;
    referrer?: Address;
}) => {
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
        triggerPrice,
    });
    const { limitOrders } = await vault.account(user).then(acc => acc.orders());
    expect(limitOrders.length).to.be.eq(0);
    // CLOSE POSITION
    await setPrice(pair, finishPrice);
    await closePosition(vault, pair, user, userWallet, key, referrer);
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
    const pos_key = await openMarketOrderWithTests(
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
    const pos_view = await closePosition(vault, pair, user, user_wallet, pos_key, referrer);
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
