import {bn, DEFAULT_TICKER, PriceNodeMockAdapter} from "./utils/common";
import {Account} from "locklift/everscale-client";
import {Token} from "./utils/wrappers/token";
import {TokenWallet} from "./utils/wrappers/token_wallet";
import {Address, Contract, fromNano, lockliftChai, toNano, zeroAddress} from "locklift";
import chai, {expect} from "chai";
import {GravixVault, MarketConfig, Oracle} from "./utils/wrappers/vault";
import {
    GravixVaultAbi,
    PairMockAbi,
    PriceNodeAbi,
    PriceNodeMockAbi,
    TokenRootUpgradeableAbi,
} from "../build/factorySource";
import BigNumber from "bignumber.js";
import {
    closeOrderWithTraceTree,
    closePosition,
    openLimitWithTestsOrder,
    openMarketOrderWithTests,
    setPrice,
} from "./utils/orders";
import {EXECUTE_STOP_ORDER_VALUE, LimitType, PosType, StopPositionType,} from "./utils/constants";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let user: Account;
    let user1: Account;
    let owner: Account;
    let usdt_root: Token;
    let stg_root: Token;
    let closePositionValue: string;

    const USDT_DECIMALS = 10 ** 6;
    const PRICE_DECIMALS = 10 ** 8;
    const LEVERAGE_DECIMALS = 10 ** 6;
    const PERCENT_100 = bn(1_000_000_000_000);
    const REF_OPEN_FEE_RATE = PERCENT_100.idiv(10);
    const REF_CLOSE_FEE_RATE = PERCENT_100.idiv(10);
    const REF_PNL_FEE_RATE = PERCENT_100.idiv(100);
    const SCALING_FACTOR = bn(10).pow(18);
    const BORROW_BASE_RATE_PER_HOUR = PERCENT_100.idiv(10).toNumber(); // 10%
    const BASE_SPREAD_RATE = PERCENT_100.idiv(1000); // 0.1%
    const OPEN_FEE_RATE = PERCENT_100.idiv(1000); // 0.1%

    const LONG_POS = 0;
    const SHORT_POS = 1;
    const empty_event = {
        eventData: "",
        eventBlock: 0,
        eventIndex: 0,
        eventTransaction: 0,
        eventBlockNumber: 0,
    };

    const empty_price = {
        price: 0,
        serverTime: 0,
        oracleTime: 0,
        ticker: "",
        signature: "",
    };

    let vault: GravixVault;
    let priceNode: Contract<PriceNodeAbi>;

    let userUsdtWallet: TokenWallet;
    let user1_usdt_wallet: TokenWallet;
    let owner_usdt_wallet: TokenWallet;
    let user_stg_wallet: TokenWallet;

    // left - eth, right - usdt
    let ethUsdtMock: Contract<PairMockAbi>;
    // left - btc, right - eth
    let btc_eth_mock: Contract<PairMockAbi>;
    let priceNodeMock: PriceNodeMockAdapter;

    const eth_addr = new Address("0:1111111111111111111111111111111111111111111111111111111111111111");
    const btc_addr = new Address("0:2222222222222222222222222222222222222222222222222222222222222222");

    const basic_config: MarketConfig = {
        priceSource: 1,
        maxLongsUSD: 100_000 * USDT_DECIMALS, // 100k
        maxShortsUSD: 100_000 * USDT_DECIMALS, // 100k
        maxLeverage: 100_000_000, // 100x
        depthAsset: 15 * USDT_DECIMALS, // 25k
        fees: {
            openFeeRate: OPEN_FEE_RATE.toNumber(), // 0.1%
            closeFeeRate: 1000000000, // 0.1%
            baseSpreadRate: BASE_SPREAD_RATE.toNumber(), // 0.1%
            baseDynamicSpreadRate: 1000000000, // 0.1%
            borrowBaseRatePerHour: BORROW_BASE_RATE_PER_HOUR, // 10%
            fundingBaseRatePerHour: 0, // disable by default
        },
        scheduleEnabled: false,
        workingHours: [],
    };

    describe("Setup contracts", async function () {
        it("Run fixtures", async function () {
            await locklift.deployments.fixture();
            const signer = (await locklift.keystore.getSigner("0"))!;

            owner = locklift.deployments.getAccount("Owner").account;
            user = locklift.deployments.getAccount("User").account;
            user1 = locklift.deployments.getAccount("User1").account;
            const { account: limitBot } = locklift.deployments.getAccount("LimitBot");

            vault = new GravixVault(locklift.deployments.getContract<GravixVaultAbi>("Vault"), owner, limitBot.address);
            stg_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT"), owner);
            usdt_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT"), owner);
            ethUsdtMock = locklift.deployments.getContract("ETH_USDT");
            userUsdtWallet = await usdt_root.wallet(user);
            const priceNodeContract = locklift.deployments.getContract<PriceNodeMockAbi>("PriceNodeMock");
            await priceNodeContract.methods
                .setTickerConfigs({
                    configs: [
                        {
                            ticker: DEFAULT_TICKER,
                            maxOracleDelay: 10000000,
                            maxServerDelay: 10000000,
                            enabled: true,
                        },
                    ],
                })
                .send({
                    from: owner.address,
                    amount: toNano(1),
                });
            priceNodeMock = new PriceNodeMockAdapter(priceNodeContract, DEFAULT_TICKER, signer);
            await vault.setPriceNode(priceNodeMock.priceNodeMock.address);
            user1_usdt_wallet = await usdt_root.wallet(user1);
            owner_usdt_wallet = await usdt_root.wallet(owner);
            closePositionValue = await vault.getClosePositionValue();
        });
    });

    describe("Running scenarios", async function () {
        let pool_balance: BigNumber;

        it("Add market to vault", async function () {
            // eth market
            const oracle: Oracle = {
                dex: {
                    targetToken: eth_addr,
                    path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                },
                priceNode: { ticker: DEFAULT_TICKER, maxOracleDelay: 0, maxServerDelay: 0 },
            };

            await locklift.tracing.trace(vault.addMarkets([basic_config]));
            await locklift.tracing.trace(vault.setOracles([[0, oracle]]));
        });

        it("Provide liquidity", async function () {
            locklift.tracing.setAllowedCodesForAddress(user.address, { compute: [60] });

            const deposit_amount = 10000000 * USDT_DECIMALS;
            const { traceTree } = await locklift.tracing.trace(vault.addLiquidity(userUsdtWallet, deposit_amount));
            expect(traceTree).to.emit("LiquidityPoolDeposit").withNamedArgs({
                usdtAmountIn: deposit_amount.toString(),
                stgUsdtAmountOut: deposit_amount.toString(),
            });

            const details = await vault.details();
            expect(details._poolAssets.stgUsdtSupply).to.be.eq(deposit_amount.toString());
            expect(details._poolAssets.balance).to.be.eq(deposit_amount.toString());
            pool_balance = bn(deposit_amount);

            user_stg_wallet = await stg_root.wallet(user);
            const user_stg_bal = await user_stg_wallet.balance();
            expect(user_stg_bal.toString()).to.be.eq(deposit_amount.toString());
        });

        // Market
        describe("Basic scenarios: Market", async function () {
            const market_idx = 0;
            // LONG loss
            describe("Test LONG stop loose", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                    const STOP_LOOSE_PRICE = 999 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        userUsdtWallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        zeroAddress,
                        STOP_LOOSE_PRICE,
                    );

                    await setPrice(priceNodeMock, STOP_LOOSE_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: 0,
                    });
                });
            });
            //LONG take profit
            describe("Test LONG take profit", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                    const TAKE_PROFIT_PRICE = 2000 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        userUsdtWallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        zeroAddress,
                        undefined,
                        TAKE_PROFIT_PRICE,
                    );

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: 1,
                    });
                });
            });
            //SHORT loss
            describe("Test SHORT stop loose", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                    const STOP_LOOSE_PRICE = 1001 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        userUsdtWallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        zeroAddress,
                        STOP_LOOSE_PRICE,
                    );

                    await setPrice(priceNodeMock, STOP_LOOSE_PRICE + 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: 0,
                    });
                });
            });
            //SHORT take profit
            describe("Test SHORT take profit", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                    const TAKE_PROFIT_PRICE = 998 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        userUsdtWallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        zeroAddress,
                        undefined,
                        TAKE_PROFIT_PRICE,
                    );

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE - 1);
                    const { traceTree } = await closeOrderWithTraceTree({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        pos_key,
                        referrer: zeroAddress,
                        stopOrderConfig: {
                            stopPositionType: StopPositionType.TakeProfit,
                        },
                        value: closePositionValue,
                    });

                    expect(Number(fromNano(traceTree!.getBalanceDiff(vault.limitBot))) * -1)
                        .lt(0.5)
                        .gt(0.45);
                });
            });
        });

        //Limit
        describe("Basic scenarios: Limit", async function () {
            const marketIdx = 0;

            // LONG/LIMIT loss
            describe("Test LONG/LIMIT/stop loose", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1050 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;
                    const STOP_LOOSE_PRICE = 999 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        stopLossTriggerPrice: STOP_LOOSE_PRICE,
                    });

                    await setPrice(priceNodeMock, STOP_LOOSE_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.StopLoss,
                    });
                });
            });

            // LONG/STOP loss
            describe("Test LONG/STOP/stop loose", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 950 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;
                    const STOP_LOOSE_PRICE = 999 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        stopLossTriggerPrice: STOP_LOOSE_PRICE,
                    });

                    await setPrice(priceNodeMock, STOP_LOOSE_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.StopLoss,
                    });
                });
            });

            // LONG/LIMIT take
            describe("Test LONG/LIMIT/take profit", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1050 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 1002 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });

            // LONG/STOP take
            describe("Test LONG/STOP/take profit", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 950 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 1002 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });

            //
            //
            // SHORT/LIMIT loss
            describe("Test SHORT/STOP/loss", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 950 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const STOP_LOSS_PRICE = 1002 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Short,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        stopLossTriggerPrice: STOP_LOSS_PRICE,
                    });

                    await setPrice(priceNodeMock, STOP_LOSS_PRICE + 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.StopLoss,
                    });
                });
            });

            // SHORT/STOP loss
            describe("Test SHORT/STOP/loss", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1050 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const STOP_LOSS_PRICE = 1002 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Short,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        stopLossTriggerPrice: STOP_LOSS_PRICE,
                    });

                    await setPrice(priceNodeMock, STOP_LOSS_PRICE + 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.StopLoss,
                    });
                });
            });
            // SHORT/LIMIT take
            describe("Test SHORT/LIMIT/Take", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 950 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 990 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Short,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE - 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });
            // SHORT/STOP take
            describe("Test SHORT/STOP/Take", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1050 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 990 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Short,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE - 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });
            // LONG/STOP loss
            describe("Test LONG/STOP/Take", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 950 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 1010 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE + 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });
            // LONG/LIMIT take profit
        });

        describe("Basic scenarios: Update stop order config after position creation", () => {
            const marketIdx = 0;

            describe("Open LONG/LIMIT and add takeProfit", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1100 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 1010 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                    });
                    const minCallValue = await vault.getSetOrUpdateTriggersValue();
                    {
                        const { traceTree } = await locklift.tracing.trace(
                            vault.contract.methods
                                .setOrUpdatePositionTriggers({
                                    _meta: {
                                        nonce: 0,
                                        callId: 0,
                                        sendGasTo: user.address,
                                    },
                                    _takeProfitTriggerPrice: TAKE_PROFIT_PRICE * 100,
                                    _marketIdx: marketIdx,
                                    _price: empty_price,
                                    _positionKey: pos_key,
                                    _stopLossTriggerPrice: 0,
                                })
                                .send({
                                    from: user.address,
                                    amount: minCallValue,
                                }),
                        );
                        // revert because this setter going to open first trigger, but value includes only base part
                        expect(traceTree).to.emit("RevertSetOrUpdatePositionTriggers");
                    }
                    const { traceTree } = await locklift.tracing.trace(
                        vault.contract.methods
                            .setOrUpdatePositionTriggers({
                                _meta: {
                                    nonce: 0,
                                    callId: 0,
                                    sendGasTo: user.address,
                                },
                                _takeProfitTriggerPrice: TAKE_PROFIT_PRICE * 100,
                                _marketIdx: marketIdx,
                                _price: empty_price,
                                _positionKey: pos_key,
                                _stopLossTriggerPrice: 0,
                            })
                            .send({
                                from: user.address,
                                amount: bn(minCallValue).plus(EXECUTE_STOP_ORDER_VALUE).toString(),
                            }),
                    );
                    const account = await vault.account(user);
                    const positions = await account.positions();
                    expect(positions[0][1].takeProfit!.triggerPrice).to.be.eq((TAKE_PROFIT_PRICE * 100).toString());
                    //add test for updating stop position config
                    await setPrice(priceNodeMock, TAKE_PROFIT_PRICE + 1);
                    await closePosition(vault, priceNodeMock, user, userUsdtWallet, pos_key, zeroAddress, {
                        stopPositionType: StopPositionType.TakeProfit,
                    });
                });
            });
            describe("Open LONG/LIMIT and add takeProfit then remove it", async function () {
                it("Create and remove take profit", async function () {
                    const INITIAL_PRICE = 1100 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;

                    const TAKE_PROFIT_PRICE = 1010 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Long,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        // takeProfitTriggerPrice: TAKE_PROFIT_PRICE,
                    });

                    const { traceTree } = await locklift.tracing.trace(
                        vault.contract.methods
                            .setOrUpdatePositionTriggers({
                                _meta: {
                                    nonce: 0,
                                    callId: 0,
                                    sendGasTo: user.address,
                                },
                                _takeProfitTriggerPrice: TAKE_PROFIT_PRICE * 100,
                                _marketIdx: marketIdx,
                                _price: empty_price,
                                _positionKey: pos_key,
                                _stopLossTriggerPrice: 0,
                            })
                            .send({
                                from: user.address,
                                amount: toNano(2),
                            }),
                    );
                    const account = await vault.account(user);
                    const positions = await account.positions();
                    expect(positions[0][1].takeProfit!.triggerPrice).to.be.eq((TAKE_PROFIT_PRICE * 100).toString());
                    {
                        const { traceTree } = await locklift.tracing.trace(
                            vault.contract.methods
                                .removePositionTriggers({
                                    meta: {
                                        nonce: 0,
                                        callId: 0,
                                        sendGasTo: user.address,
                                    },
                                    positionKey: pos_key,
                                    marketIdx: marketIdx,
                                    removeTakeProfit: true,
                                    removeStopLoss: false,
                                })
                                .send({
                                    from: user.address,
                                    amount: toNano(2),
                                }),
                        );
                        const positions = await account.positions();
                        expect(positions[0][1].takeProfit).to.be.eq(null);
                    }
                    await vault.closePosition(user, pos_key, marketIdx);
                });
            });
        });

        describe("Basic scenarios: Negative cases with high borrow fee", () => {
            const marketIdx = 0;
            describe("Test SHORT/STOP/loss with high borrow fee", async function () {
                it("Pnl+, 10x leverage, open/close 1000$/1100$", async function () {
                    const INITIAL_PRICE = 1050 * USDT_DECIMALS;
                    const LIMIT_TRIGGER_PRICE = 1000 * USDT_DECIMALS;
                    const COLLATERAL = 100 * USDT_DECIMALS;
                    const LEVERAGE = 10 * LEVERAGE_DECIMALS;

                    const STOP_LOSS_PRICE = 1002 * USDT_DECIMALS;
                    await setPrice(priceNodeMock, INITIAL_PRICE);
                    // OPEN POSITION
                    const pos_key = await openLimitWithTestsOrder({
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx,
                        posType: PosType.Short,
                        pair: priceNodeMock,
                        vault,
                        triggerPrice: LIMIT_TRIGGER_PRICE,
                        referrer: zeroAddress,
                        leverage: LEVERAGE,
                        collateral: COLLATERAL,
                        limitType: LimitType.Stop,
                        stopLossTriggerPrice: STOP_LOSS_PRICE,
                    });
                    const account = await vault.account(user);
                    const positions = await account.positions();
                    debugger;
                    expect(positions[0][1].stopLoss!.triggerPrice).to.be.eq((STOP_LOSS_PRICE * 100).toString());
                    {
                        const { traceTree } = await locklift.tracing.trace(
                            vault.contract.methods
                                .removePositionTriggers({
                                    meta: {
                                        nonce: 0,
                                        callId: 0,
                                        sendGasTo: user.address,
                                    },
                                    positionKey: pos_key,
                                    marketIdx: marketIdx,
                                    removeTakeProfit: true,
                                    removeStopLoss: true,
                                })
                                .send({
                                    from: user.address,
                                    amount: toNano(2),
                                }),
                        );
                        const positions = await account.positions();
                        expect(positions[0][1].stopLoss).to.be.eq(null);
                    }
                    await locklift.testing.increaseTime(60 * 60 * 7.5);
                    const positionView = await account.getPositionView(pos_key, 0, {
                        accLongUSDFundingPerShare: 0,
                        accShortUSDFundingPerShare: 0,
                    });
                    const { traceTree } = await locklift.tracing.trace(
                        vault.contract.methods
                            .setOrUpdatePositionTriggers({
                                _meta: {
                                    nonce: 0,
                                    callId: 0,
                                    sendGasTo: user.address,
                                },
                                _takeProfitTriggerPrice: 0,
                                _marketIdx: marketIdx,
                                _price: empty_price,
                                _positionKey: pos_key,
                                _stopLossTriggerPrice: STOP_LOSS_PRICE * 100,
                            })
                            .send({
                                from: user.address,
                                amount: toNano(2),
                            }),
                    );
                    expect(traceTree).to.emit("RevertSetOrUpdatePositionTriggers").withNamedArgs({
                        callId: "0",
                        user: user.address,
                        positionKey: pos_key.toString(),
                    });
                });
            });
        });
    });
});
