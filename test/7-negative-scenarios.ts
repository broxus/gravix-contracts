import { bn, DEFAULT_TICKER, deployUser, PriceNodeMockAdapter } from "./utils/common";
import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { Address, Contract, getRandomNonce, lockliftChai, toNano, zeroAddress } from "locklift";
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
    openMarketOrder,
    openMarketOrderWithTests,
    setPrice,
    testMarketPosition,
    testPositionFunding,
} from "./utils/orders";
import {
    BOUNCE_HANDLING_FEE,
    FEE_FOR_TOKEN_TRANSFER,
    OPEN_ORDER_FEE,
    ORACLE_PROXY_CALL,
    ORACLE_PROXY_DEPLOY,
} from "./utils/constants";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let user: Account;
    let user1: Account;
    let owner: Account;

    let usdRoot: Token;
    let stgRoot: Token;
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
    let user1UsdtWallet: TokenWallet;
    let ownerUsdtWallet: TokenWallet;
    let user_stg_wallet: TokenWallet;

    // left - eth, right - usdt
    let ethUsdtMock: Contract<PairMockAbi>;
    // left - btc, right - eth
    let btc_eth_mock: Contract<PairMockAbi>;

    let priceNodeMock: PriceNodeMockAdapter;

    const eth_addr = new Address("0:1111111111111111111111111111111111111111111111111111111111111111");
    const btc_addr = new Address("0:2222222222222222222222222222222222222222222222222222222222222222");
    const MARKET_IDX = 0;
    const GRAVIX_ACCOUNT_DEPLOY_VALUE = toNano(0.65);
    const MIN_MSG_VALUE_FOR_OPEN_ORDER = toNano(0.55);

    const basic_config: MarketConfig = {
        priceSource: 1,
        maxLongsUSD: 100_000 * USDT_DECIMALS, // 100k
        maxShortsUSD: 100_000 * USDT_DECIMALS, // 100k
        noiWeight: 100,
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
            stgRoot = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT"), owner);
            usdRoot = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT"), owner);
            ethUsdtMock = locklift.deployments.getContract("ETH_USDT");
            priceNodeMock = new PriceNodeMockAdapter(
                locklift.deployments.getContract("PriceNodeMock"),
                DEFAULT_TICKER,
                signer,
            );
            await vault.setPriceNode(priceNodeMock.priceNodeMock.address);
            userUsdtWallet = await usdRoot.wallet(user);
            user1UsdtWallet = await usdRoot.wallet(user1);
            ownerUsdtWallet = await usdRoot.wallet(owner);
        });
    });

    describe("Running scenarios", async function () {
        let pool_balance: BigNumber;

        it("Add market to vault", async function () {
            // eth market
            const oracle: Oracle = {
                dex: {
                    targetToken: eth_addr,
                    path: [{ addr: ethUsdtMock.address, leftRoot: eth_addr, rightRoot: usdRoot.address }],
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

            user_stg_wallet = await stgRoot.wallet(user);
            const user_stg_bal = await user_stg_wallet.balance();
            expect(user_stg_bal.toString()).to.be.eq(deposit_amount.toString());
        });

        describe("Open order tests with different gas values", async () => {
            it("try to open order with minimal required gas", async () => {
                const INITIAL_PRICE = 1000 * USDT_DECIMALS;

                await setPrice(priceNodeMock, INITIAL_PRICE);
                const openMarketOrderMinValue = await vault.getOpenOrderBaseValue(false).then(res => res.market);

                const { traceTree } = await locklift.tracing.trace(
                    openMarketOrder({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        leverage: LEVERAGE_DECIMALS,
                        marketIdx: MARKET_IDX,
                        posType: LONG_POS,
                        collateral: 100 * USDT_DECIMALS,
                        value: openMarketOrderMinValue,
                    }),
                    {
                        raise: true,
                        allowedCodes: {
                            compute: [null],
                        },
                    },
                );
                expect(traceTree)
                    .and.to.emit("MarketOrderRequestRevert")
                    //there is no success process_requestMarketOrder call
                    .and.not.to.be.call("process_requestMarketOrder");
            });
            it("try to open order with full required gas", async () => {
                const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                await setPrice(ethUsdtMock, INITIAL_PRICE);
                const openMarketOrderFullValue = await vault.getFullOpenOrderValue(false).then(res => res.market);
                const callId = getRandomNonce();
                const { traceTree } = await locklift.tracing.trace(
                    openMarketOrder({
                        vault,
                        pair: ethUsdtMock,
                        user,
                        userWallet: userUsdtWallet,
                        leverage: LEVERAGE_DECIMALS,
                        marketIdx: MARKET_IDX,
                        posType: LONG_POS,
                        collateral: 100 * USDT_DECIMALS,
                        value: openMarketOrderFullValue,
                        callId,
                    }),
                    {
                        raise: false,
                        allowedCodes: {
                            compute: [null],
                        },
                    },
                );
                expect(traceTree).and.to.emit("MarketOrderExecution").withNamedArgs({
                    callId: callId.toString(),
                });
            });
            it("try to open order with minimal required gas, and existed account", async () => {
                const INITIAL_PRICE = 1000 * USDT_DECIMALS;

                await setPrice(priceNodeMock, INITIAL_PRICE);
                const callId = getRandomNonce();

                const openMarketOrderMinValue = await vault.getOpenOrderBaseValue(false).then(res => res.market);
                const { traceTree } = await locklift.tracing.trace(
                    openMarketOrder({
                        vault,
                        pair: priceNodeMock,
                        user,
                        userWallet: userUsdtWallet,
                        leverage: LEVERAGE_DECIMALS,
                        marketIdx: MARKET_IDX,
                        posType: LONG_POS,
                        collateral: 100 * USDT_DECIMALS,
                        value: openMarketOrderMinValue,
                        callId,
                    }),
                    {
                        raise: false,
                        allowedCodes: {
                            compute: [null],
                        },
                    },
                );
                expect(traceTree).and.to.emit("MarketOrderExecution").withNamedArgs({
                    callId: callId.toString(),
                });
            });
        });
    });
});
