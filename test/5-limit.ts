import { bn, DEFAULT_TICKER, PriceNodeMockAdapter } from "./utils/common";
import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { Address, Contract, lockliftChai, toNano } from "locklift";
import chai, { expect } from "chai";
import { GravixVault, MarketConfig, Oracle } from "./utils/wrappers/vault";
import {
    GravixVaultAbi,
    PairMockAbi,
    PriceNodeAbi,
    PriceNodeMockAbi,
    TokenRootUpgradeableAbi,
} from "../build/factorySource";
import BigNumber from "bignumber.js";
import {
    closePosition,
    openMarketOrderWithTests,
    setPrice,
    testLimitPosition,
    testMarketPosition,
} from "./utils/orders";
import { LimitType, RETRIEVE_REFERRER_VALUE } from "./utils/constants";

chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let user: Account;
    let user1: Account;
    let owner: Account;
    let openLimitOrderBaseValue: string;
    let openLimitOrderFullValue: string;
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
            userUsdtWallet = await usdt_root.wallet(user);
            user1_usdt_wallet = await usdt_root.wallet(user1);
            owner_usdt_wallet = await usdt_root.wallet(owner);

            openLimitOrderBaseValue = await vault.getOpenOrderBaseValue(false).then(res => res.limit);
            openLimitOrderFullValue = await vault.getFullOpenOrderValue(false).then(res => res.limit);
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

        describe("Basic scenarios: open fee, pnl, close fee, spreads, liq price checked", async function () {
            const marketIdx = 0;

            describe("Test solo long positions", async function () {
                it("Pnl+, 1x leverage, LIMIT/LONG open/close 1050$/1000$/1100$", async function () {
                    await vault.deployGravixAccount(user1);
                    await testLimitPosition({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx: marketIdx,
                        leverage: LEVERAGE_DECIMALS,
                        initialPrice: 1050 * USDT_DECIMALS,
                        triggerPrice: 1000 * USDT_DECIMALS,
                        finishPrice: 1100 * USDT_DECIMALS,
                        posType: LONG_POS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        referrer: user1.address,
                        value: bn(openLimitOrderFullValue).plus(RETRIEVE_REFERRER_VALUE).toString(),
                    });
                });
            });
            describe("Test solo short positions", async function () {
                it("Pnl+, 1x leverage, LIMIT/SHORT 950$/1000$/900$", async function () {
                    await testLimitPosition({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx: marketIdx,
                        leverage: LEVERAGE_DECIMALS,
                        initialPrice: 950 * USDT_DECIMALS,
                        triggerPrice: 1000 * USDT_DECIMALS,
                        finishPrice: 900 * USDT_DECIMALS,
                        posType: SHORT_POS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Limit,
                        value: openLimitOrderBaseValue,
                    });
                });
            });
            describe("Test solo short positions", async function () {
                it("Pnl+, 1x leverage, STOP/LONG 950$/1000$/1100$", async function () {
                    await testLimitPosition({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx: marketIdx,
                        leverage: LEVERAGE_DECIMALS,
                        initialPrice: 950 * USDT_DECIMALS,
                        triggerPrice: 1000 * USDT_DECIMALS,
                        finishPrice: 1100 * USDT_DECIMALS,
                        posType: LONG_POS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        value: openLimitOrderBaseValue,
                    });
                });
            });
            describe("Test solo short positions", async function () {
                it("Pnl+, 1x leverage, STOP/SHORT 950$/1000$/1100$", async function () {
                    await testLimitPosition({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        marketIdx: marketIdx,
                        leverage: LEVERAGE_DECIMALS,
                        initialPrice: 1000 * USDT_DECIMALS,
                        triggerPrice: 950 * USDT_DECIMALS,
                        finishPrice: 900 * USDT_DECIMALS,
                        posType: SHORT_POS,
                        collateral: 100 * USDT_DECIMALS,
                        limitType: LimitType.Stop,
                        value: openLimitOrderBaseValue,
                    });
                });
            });
        });
    });
});
