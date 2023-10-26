import { bn, DEFAULT_TICKER, deployUser, nannoToEverNumber, PriceNodeMockAdapter } from "./utils/common";
import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { Address, Contract, lockliftChai, toNano, zeroAddress } from "locklift";
import chai, { expect } from "chai";
import { GravixVault, MarketConfig, Oracle } from "./utils/wrappers/vault";
import {
    GravixVaultAbi,
    PairMockAbi,
    PriceNodeAbi,
    PriceNodeMockAbi,
    TokenRootUpgradeableAbi,
} from "../build/factorySource";
import { GravixAccount } from "./utils/wrappers/vault_acc";
import BigNumber from "bignumber.js";
import {
    closePosition,
    openMarketOrderWithTests,
    setPrice,
    testMarketPosition,
    testPositionFunding,
} from "./utils/orders";
import { EDIT_COLLATERAL_FEES, FEE_FOR_TOKEN_TRANSFER, RETRIEVE_REFERRER_VALUE } from "./utils/constants";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let user: Account;
    let user1: Account;
    let owner: Account;
    let openMarketOrderBaseValue: string;
    let openMarketOrderFullValue: string;
    let closePositionValue: string;

    let usdt_root: Token;
    let stg_root: Token;
    const USDT_DECIMALS = 10 ** 6;
    const PRICE_DECIMALS = 10 ** 8;
    const LEVERAGE_DECIMALS = 10 ** 6;
    const PERCENT_100 = bn(1_000_000_000_000);
    const REF_OPEN_FEE_RATE = PERCENT_100.idiv(10);
    const REF_CLOSE_FEE_RATE = PERCENT_100.idiv(10);
    const REF_PNL_FEE_RATE = PERCENT_100.idiv(100);
    const SCALING_FACTOR = bn(10).pow(18);
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

    let user_usdt_wallet: TokenWallet;
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
            openFeeRate: 1000000000, // 0.1%
            closeFeeRate: 1000000000, // 0.1%
            baseSpreadRate: 1000000000, // 0.1%
            baseDynamicSpreadRate: 1000000000, // 0.1%
            borrowBaseRatePerHour: 0, // disable by default
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
            user_usdt_wallet = await usdt_root.wallet(user);
            user1_usdt_wallet = await usdt_root.wallet(user1);
            owner_usdt_wallet = await usdt_root.wallet(owner);

            openMarketOrderBaseValue = await vault.getOpenOrderBaseValue(false).then(res => res.market);
            openMarketOrderFullValue = await vault.getFullOpenOrderValue(false).then(res => res.market);
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
            const { traceTree } = await locklift.tracing.trace(vault.addLiquidity(user_usdt_wallet, deposit_amount));
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

        describe("Basic scenarios: open fee, pnl, close fee, spreads, liq price checked", async function () {
            const market_idx = 0;

            describe("Test solo long positions", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/1100$", async function () {
                    const openMarketOrderFullValue = await vault.getFullOpenOrderValue(false).then(res => res.market);

                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        1100 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderFullValue,
                        closePositionValue,
                    );
                });

                it("Pnl+, 10x leverage, open/close 1000$/1500$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        10 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        1500 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl+, 100x leverage, open/close 1000$/2000$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        2000 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 1x leverage, open/close 1000$/500$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        500 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 10x leverage, open/close 1000$/950$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        10 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        950 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 100x leverage, open/close 1000$/995$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        995 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });
            });

            describe("Test solo short positions", async function () {
                it("Pnl+, 1x leverage, open/close 1000$/900$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        900 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl+, 10x leverage, open/close 1000$/650$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        10 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        650 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl+, 100x leverage, open/close 1000$/300$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        300 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 1x leverage, open/close 1000$/1850$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        1850 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 10x leverage, open/close 1000$/1050$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        10 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        1050 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });

                it("Pnl-, 100x leverage, open/close 1000$/1005$", async function () {
                    await testMarketPosition(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        1005 * USDT_DECIMALS,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );
                });
            });

            describe("Mixed case", async function () {
                let long_pos_key: number, long_pos2_key: number;
                let short_pos_key: number, short_pos2_key: number;

                it("Opening positions at 1000$", async function () {
                    await setPrice(priceNodeMock, 1000 * USDT_DECIMALS);
                    long_pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                    short_pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                    long_pos2_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                    short_pos2_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                });

                it("Closing positions at 1100$/900$", async function () {
                    await setPrice(priceNodeMock, 1100 * USDT_DECIMALS);
                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, long_pos_key);
                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, short_pos_key);

                    await setPrice(priceNodeMock, 900 * USDT_DECIMALS);
                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, long_pos2_key);
                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, short_pos2_key);
                });
            });
        });

        describe("Advanced scenarios: funding and borrow fee checked", async function () {
            let market_idx: number;
            let base_funding = 1000000000; // 0.1%

            it("Add market with borrow rate > 0", async function () {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 1000000000; // 0.1% per hour
                new_config.fees.fundingBaseRatePerHour = 0; // 0.1%

                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: DEFAULT_TICKER, maxOracleDelay: 0, maxServerDelay: 0 },
                };

                market_idx = 1;
                await locklift.tracing.trace(vault.addMarkets([new_config]));
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it("Testing borrow fee", async function () {
                await testMarketPosition(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    1000 * USDT_DECIMALS,
                    1100 * USDT_DECIMALS,
                    86400, // 1 day
                    undefined,
                    openMarketOrderBaseValue,
                    closePositionValue,
                );

                await testMarketPosition(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    SHORT_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    1000 * USDT_DECIMALS,
                    1100 * USDT_DECIMALS,
                    86400, // 1 day
                    undefined,
                    openMarketOrderBaseValue,
                    closePositionValue,
                );
            });

            it("Add market with funding rate > 0", async function () {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 0;
                new_config.fees.fundingBaseRatePerHour = base_funding; // 0.1%

                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: DEFAULT_TICKER, maxOracleDelay: 0, maxServerDelay: 0 },
                };

                market_idx = 2;
                await locklift.tracing.trace(vault.addMarkets([new_config]));
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            describe("Testing funding fee", async function () {
                it("Solo long position", async function () {
                    await testPositionFunding(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        3600,
                    );
                });

                it("Solo short position", async function () {
                    await testPositionFunding(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        3600,
                    );
                });

                it("Longs > shorts", async function () {
                    // big long
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );

                    await testPositionFunding(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        1000000,
                        1000 * USDT_DECIMALS,
                        7200,
                    );

                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, pos_key);
                });

                it("Shorts > longs", async function () {
                    // big short
                    const pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100 * LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                        closePositionValue,
                    );

                    await testPositionFunding(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        1000 * USDT_DECIMALS,
                        7200,
                    );

                    await closePosition(vault, priceNodeMock, user, user_usdt_wallet, pos_key);
                });
            });
        });

        describe("Liquidations", async function () {
            let market_idx: number;

            it("Add market without borrow/funding fee", async function () {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 0;
                new_config.fees.fundingBaseRatePerHour = 0;

                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: DEFAULT_TICKER, maxOracleDelay: 0, maxServerDelay: 0 },
                };

                await locklift.tracing.trace(vault.addMarkets([new_config]));
                market_idx = Number((await vault.contract.methods.getDetails({ answerId: 0 }).call())._marketCount) - 1;
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it("Test liquidation occurs correctly", async function () {
                const price = 1000 * USDT_DECIMALS;
                await setPrice(priceNodeMock, price);

                const pos_key1 = await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    100000000,
                    undefined,
                    undefined,
                    undefined,
                    openMarketOrderBaseValue,
                );

                const pos_key2 = await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    50000000,
                    undefined,
                    undefined,
                    undefined,
                    openMarketOrderBaseValue,
                );

                const acc = await vault.account(user);
                const view1 = await acc.getPositionView(pos_key1, price * 100, {
                    accLongUSDFundingPerShare: 0,
                    accShortUSDFundingPerShare: 0,
                });
                const view2 = await acc.getPositionView(pos_key2, price * 100, {
                    accLongUSDFundingPerShare: 0,
                    accShortUSDFundingPerShare: 0,
                });

                // move price to liquidate first one, but don't touch second one
                // just 1$ down 1st position liq price
                const new_price = bn(view1.positionView.liquidationPrice).minus(PRICE_DECIMALS);
                await setPrice(priceNodeMock, new_price.idiv(100).toFixed());

                const view11 = await acc.getPositionView(pos_key1, new_price.toFixed(), {
                    accLongUSDFundingPerShare: 0,
                    accShortUSDFundingPerShare: 0,
                });
                const view22 = await acc.getPositionView(pos_key2, new_price.toFixed(), {
                    accLongUSDFundingPerShare: 0,
                    accShortUSDFundingPerShare: 0,
                });

                expect(view11.positionView.liquidate).to.be.true;
                expect(view22.positionView.liquidate).to.be.false;

                // now try liquidate
                const { traceTree } = await locklift.tracing.trace(
                    vault.liquidatePositions([
                        [
                            market_idx,
                            {
                                price: empty_price,
                                positions: [
                                    { user: user.address, positionKey: pos_key1 },
                                    { user: user.address, positionKey: pos_key2 },
                                ],
                            },
                        ],
                    ]),
                );
                expect(traceTree).to.emit("LiquidatePosition").withNamedArgs({
                    user: user.address,
                    positionKey: pos_key1,
                });
                expect(traceTree).to.emit("LiquidatePositionRevert").withNamedArgs({
                    user: user.address,
                    positionKey: pos_key2,
                });

                // now liquidate 2nd position
                const new_price2 = bn(view2.positionView.liquidationPrice).minus(PRICE_DECIMALS);
                await setPrice(priceNodeMock, new_price2.idiv(100).toFixed());

                const { traceTree: traceTree2 } = await locklift.tracing.trace(
                    vault.liquidatePositions([
                        [
                            market_idx,
                            {
                                price: empty_price,
                                positions: [{ user: user.address, positionKey: pos_key2 }],
                            },
                        ],
                    ]),
                );
                expect(traceTree2).to.emit("LiquidatePosition").withNamedArgs({
                    user: user.address,
                    positionKey: pos_key2,
                });
            });

            it("Add market with borrow fee > 0", async function () {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 1000000000; // 0.1% per hour
                new_config.fees.fundingBaseRatePerHour = 0;

                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: DEFAULT_TICKER, maxOracleDelay: 0, maxServerDelay: 0 },
                };

                await locklift.tracing.trace(vault.addMarkets([new_config]));
                market_idx = Number((await vault.contract.methods.getDetails({ answerId: 0 }).call())._marketCount) - 1;
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it("Test liquidation price moves when borrow fee accumulate", async function () {
                const price = 1000 * USDT_DECIMALS;
                await setPrice(priceNodeMock, price);

                const pos_key = await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    100000000,
                    undefined,
                    undefined,
                    undefined,
                    openMarketOrderBaseValue,
                );
            });
        });

        describe("Edit collateral", async function () {
            let pos_key: number;

            describe("Add collateral", async function () {
                it("Open position", async function () {
                    await setPrice(priceNodeMock, 1000 * USDT_DECIMALS);
                    pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        0,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                });

                it("Add collateral", async function () {
                    const account = await vault.account(user);
                    const pos = (await account.contract.methods.getPosition({ posKey: pos_key, answerId: 0 }).call())
                        .position;

                    const amount = 50000000;
                    const { traceTree } = await locklift.tracing.trace(
                        vault.addCollateral(
                            user_usdt_wallet,
                            user,
                            amount,
                            pos_key,
                            0,
                            undefined,
                            bn(FEE_FOR_TOKEN_TRANSFER).plus(EDIT_COLLATERAL_FEES).toString(),
                        ),
                    );
                    const userBalanceChange = traceTree!.getBalanceDiff(user.address);
                    expect(nannoToEverNumber(userBalanceChange) * -1).to.be.lt(nannoToEverNumber(EDIT_COLLATERAL_FEES));

                    const old_col = bn(pos.initialCollateral).minus(pos.openFee);
                    const new_col = old_col.plus(amount);
                    const leveraged_position_usd = old_col.times(pos.leverage).idiv(100);
                    const new_leverage = leveraged_position_usd.times(100).idiv(new_col);

                    expect(traceTree)
                        .to.emit("AddPositionCollateral")
                        .withNamedArgs({
                            amount: amount.toFixed(),
                            updatedPos: {
                                leverage: new_leverage.toFixed(),
                            },
                        });

                    const pos2 = (await account.contract.methods.getPosition({ posKey: pos_key, answerId: 0 }).call())
                        .position;
                    expect(pos2.initialCollateral).to.be.eq(bn(pos.initialCollateral).plus(amount).toFixed());
                    expect(pos2.leverage).to.be.eq(new_leverage.toFixed());
                });
            });

            describe("Remove collateral", async function () {
                it("Open position", async function () {
                    pos_key = await openMarketOrderWithTests(
                        vault,
                        priceNodeMock,
                        user,
                        user_usdt_wallet,
                        0,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS,
                        undefined,
                        undefined,
                        undefined,
                        openMarketOrderBaseValue,
                    );
                });

                it("Remove collateral", async function () {
                    const account = await vault.account(user);
                    const pos = (await account.contract.methods.getPosition({ posKey: pos_key, answerId: 0 }).call())
                        .position;

                    const amount = 50000000;
                    const { traceTree } = await locklift.tracing.trace(
                        vault.removeCollateral(
                            user,
                            amount,
                            pos_key,
                            0,
                            1,
                            bn(FEE_FOR_TOKEN_TRANSFER).plus(EDIT_COLLATERAL_FEES).toString(),
                        ),
                    );
                    const userBalanceChange = traceTree!.getBalanceDiff(user.address);
                    expect(nannoToEverNumber(userBalanceChange) * -1).to.be.lt(nannoToEverNumber(EDIT_COLLATERAL_FEES));
                    const old_col = bn(pos.initialCollateral).minus(pos.openFee);
                    const new_col = old_col.minus(amount);
                    const leveraged_position_usd = old_col.times(pos.leverage).idiv(100);
                    const new_leverage = leveraged_position_usd.times(100).idiv(new_col);

                    expect(traceTree)
                        .to.emit("RemovePositionCollateral")
                        .withNamedArgs({
                            amount: amount.toFixed(),
                            updatedPos: {
                                leverage: new_leverage.toFixed(),
                            },
                        });

                    const pos2 = (await account.contract.methods.getPosition({ posKey: pos_key, answerId: 0 }).call())
                        .position;
                    expect(pos2.initialCollateral).to.be.eq(bn(pos.initialCollateral).minus(amount).toFixed());
                    expect(pos2.leverage).to.be.eq(new_leverage.toFixed());
                });
            });
        });

        describe("Max PNL rate", async function () {
            const market_idx = 0;
            let long_pos_key: number;

            it("Set max PNL rate to 200%", async function () {
                await locklift.tracing.trace(
                    vault.contract.methods
                        .setMaxPnlRate({
                            newMaxRate: PERCENT_100.times(2).toFixed(),
                            meta: { callId: 0, nonce: 0, sendGasTo: user.address },
                        })
                        .send({ amount: toNano(3), from: owner.address }),
                );
            });

            it("Pnl+, 100x leverage, open at 1000$", async function () {
                await setPrice(priceNodeMock, 1000 * USDT_DECIMALS);
                long_pos_key = await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    100 * LEVERAGE_DECIMALS,
                    undefined,
                    undefined,
                    undefined,
                    openMarketOrderBaseValue,
                );
            });

            it("Closing positions at 5000$", async function () {
                await setPrice(priceNodeMock, 5000 * USDT_DECIMALS);
                await closePosition(vault, priceNodeMock, user, user_usdt_wallet, long_pos_key);
            });
        });

        describe("Referrals", async function () {
            const market_idx = 0;
            let user1_long_pos_key: number;
            let owner_long_pos_key: number;
            let user2: Account;
            let user3: Account;
            let user4: Account;

            it("User set referrer on deploying account", async function () {
                user2 = await deployUser();
                user3 = await deployUser();

                await locklift.tracing.trace(
                    vault.contract.methods
                        .deployGravixAccount({
                            answerId: 0,
                            meta: { callId: 0, sendGasTo: owner.address, nonce: 0 },
                            referrer: zeroAddress,
                        })
                        .send({ from: user2.address, amount: toNano(1) }),
                );

                await locklift.tracing.trace(
                    vault.contract.methods
                        .deployGravixAccount({
                            answerId: 0,
                            meta: { callId: 0, sendGasTo: owner.address, nonce: 0 },
                            referrer: user2.address,
                        })
                        .send({ from: user3.address, amount: toNano(1) }),
                );

                const account = await vault.account(user3);
                const details = await account.contract.methods.getDetails({ answerId: 0 }).call();
                expect(details._referrer.toString()).to.be.eq(zeroAddress.toString());
            });

            it("User set referrer on position open", async function () {
                await setPrice(priceNodeMock, 1000 * USDT_DECIMALS);
                await locklift.tracing.trace(
                    vault.contract.methods
                        .deployGravixAccount({
                            answerId: 0,
                            meta: { callId: 0, sendGasTo: owner.address, nonce: 0 },
                            referrer: zeroAddress,
                        })
                        .send({ from: owner.address, amount: toNano(1) }),
                );

                user1_long_pos_key = await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user1,
                    user1_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    owner.address, // owner as a referrer
                );

                const user1_acc = await vault.account(user1);
                // get position
                // @ts-ignore
                const [pos_key, pos] = (await user1_acc.positions()).pop();
                const expected_ref_fee = bn(pos.openFee).times(REF_OPEN_FEE_RATE).idiv(PERCENT_100);

                const user1_details = await user1_acc.contract.methods.getDetails({ answerId: 0 }).call();
                // check referrer is set correctly
                expect(user1_details._referrer.toString()).to.be.eq(owner.address.toString());
                // check event is emitted
                const event = (await vault.getEvent("ReferralPayment"))! as any;
                expect(event.referrer.toString()).to.be.eq(owner.address.toString());
                expect(event.referral.toString()).to.be.eq(user1.address.toString());
                expect(event.amount).to.be.eq(expected_ref_fee.toFixed());

                const owner_acc = await vault.account(owner);
                const owner_details = await owner_acc.contract.methods.getDetails({ answerId: 0 }).call();
                // check referrer got his balance
                expect(owner_details._referralBalance).to.be.eq(event.amount);
            });

            it("Closing position with referrer", async function () {
                await setPrice(priceNodeMock, 1100 * USDT_DECIMALS);
                await closePosition(
                    vault,
                    priceNodeMock,
                    user1,
                    user1_usdt_wallet,
                    user1_long_pos_key,
                    undefined,
                    undefined,
                    closePositionValue,
                );
            });

            it("User set referer + grand referer on position open", async function () {
                await setPrice(priceNodeMock, 1000 * USDT_DECIMALS);

                user4 = await deployUser();
                const user4_usdt_wallet = await usdt_root.mint(1000000000, user4);

                await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user4,
                    user4_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    user1.address, // user1 as a referrer + owner as a grand referrer
                    undefined,
                    undefined,
                    bn(openMarketOrderFullValue).plus(RETRIEVE_REFERRER_VALUE).multipliedBy(2).toString(),
                );
            });

            it("User try to change existing referrer", async function () {
                const user1_acc = await vault.account(user1);
                const user1_details = await user1_acc.contract.methods.getDetails({ answerId: 0 }).call();
                // remember our original referrer

                // try to change referrer
                await openMarketOrderWithTests(
                    vault,
                    priceNodeMock,
                    user1,
                    user1_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    vault.address, // any address could be here, we just check original referrer is not changed
                    undefined,
                    undefined,
                    openMarketOrderBaseValue,
                );

                const user1_details_2 = await user1_acc.contract.methods.getDetails({ answerId: 0 }).call();
                expect(user1_details._referrer.toString()).to.be.eq(user1_details_2._referrer.toString());
            });

            it("Referrer withdraw his referral balance", async function () {
                const owner_acc = await vault.account(owner);
                const owner_details = await owner_acc.contract.methods.getDetails({ answerId: 0 }).call();

                const { traceTree } = await locklift.tracing.trace(
                    vault.contract.methods
                        .withdrawReferralBalance({ meta: { callId: 0, sendGasTo: owner.address, nonce: 0 } })
                        .send({ from: owner.address, amount: toNano(2.5) }),
                );

                expect(traceTree).to.emit("ReferralBalanceWithdraw").withNamedArgs({
                    user: owner.address.toString(),
                    amount: owner_details._referralBalance.toString(),
                });

                // check ref balance is zero
                const owner_details_2 = await owner_acc.contract.methods.getDetails({ answerId: 0 }).call();
                expect(owner_details_2._referralBalance).to.be.eq("0");
            });
        });
    });
});
