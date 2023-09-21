import { bn, deployUser, unwrapAddresses } from "./utils/common";
import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { Address, Contract, lockliftChai, toNano, zeroAddress } from "locklift";
import chai, { expect } from "chai";
import { GravixVault, MarketConfig, Oracle } from "./utils/wrappers/vault";
import { GravixVaultAbi, PairMockAbi, PriceNodeAbi, TokenRootUpgradeableAbi } from "../build/factorySource";
import { GravixAccount } from "./utils/wrappers/vault_acc";
import BigNumber from "bignumber.js";
import {
    closePosition,
    openLimitWithTestsOrder,
    openMarketOrder,
    openMarketOrderWithTests,
    setPrice,
    testMarketPosition,
    testPositionFunding,
} from "./utils/orders";
import { LimitType, PosType } from "./utils/constants";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let user: Account;
    let user1: Account;
    let owner: Account;

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

    const eth_addr = new Address("0:1111111111111111111111111111111111111111111111111111111111111111");
    const btc_addr = new Address("0:2222222222222222222222222222222222222222222222222222222222222222");

    const basic_config: MarketConfig = {
        priceSource: 0,
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
    const MARKET_IDX = 0;
    describe("Setup contracts", async function () {
        it("Run fixtures", async function () {
            await locklift.deployments.fixture();
            owner = locklift.deployments.getAccount("Owner").account;
            user = locklift.deployments.getAccount("User").account;
            user1 = locklift.deployments.getAccount("User1").account;
            const { account: limitBot } = locklift.deployments.getAccount("LimitBot");
            vault = new GravixVault(locklift.deployments.getContract<GravixVaultAbi>("Vault"), owner, limitBot.address);
            stg_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT"), owner);
            usdt_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT"), owner);
            ethUsdtMock = locklift.deployments.getContract("ETH_USDT");
            userUsdtWallet = await usdt_root.wallet(user);
            user1_usdt_wallet = await usdt_root.wallet(user1);
            owner_usdt_wallet = await usdt_root.wallet(owner);
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
                priceNode: { ticker: "", maxOracleDelay: 0, maxServerDelay: 0 },
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
            it("Try to open position with outdated account version", async function () {
                const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                await setPrice(ethUsdtMock, INITIAL_PRICE);
                await vault.deployGravixAccount(user1);

                await vault.deployGravixAccount(user, user1.address);
                {
                    const { traceTree } = await locklift.tracing.trace(vault.setNewAccountCode());
                }
                const oldAccountVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(oldAccountVersion).to.be.eq(0);
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
                    }),
                    { raise: false },
                );
                const newVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(newVersion).to.be.eq(1);
                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "0",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "1",
                    })
                    .and.call("revert_requestMarketOrder")
                    .and.emit("MarketOrderRequestRevert");
            });

            it("Open long position", async function () {
                await openMarketOrderWithTests(
                    vault,
                    ethUsdtMock,
                    user,
                    userUsdtWallet,
                    MARKET_IDX,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    LEVERAGE_DECIMALS,
                    user1.address,
                );
            });

            it("Try to close position with outdated account version", async function () {
                {
                    const { traceTree } = await locklift.tracing.trace(vault.setNewAccountCode());
                }
                const oldAccountVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(oldAccountVersion).to.be.eq(1);

                const posKey = await vault.account(user).then(res => res.positions().then(res => Number(res[0][0])));
                const { traceTree } = await locklift.tracing.trace(vault.closePosition(user, posKey, MARKET_IDX));
                const newVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(newVersion).to.be.eq(2);
                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "1",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "2",
                    })
                    .and.call("revert_closePosition")
                    .and.emit("ClosePositionRevert");
            });
            it("Try to add collateral position with outdated account version", async function () {
                {
                    const { traceTree } = await locklift.tracing.trace(vault.setNewAccountCode());
                }
                const oldAccountVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(oldAccountVersion).to.be.eq(2);

                const posKey = await vault.account(user).then(res => res.positions().then(res => Number(res[0][0])));
                const { traceTree } = await locklift.tracing.trace(
                    vault.addCollateral(userUsdtWallet, user, 100 * USDT_DECIMALS, posKey, MARKET_IDX),
                );
                const newVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(newVersion).to.be.eq(3);
                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "2",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "3",
                    })
                    .and.call("revert_addCollateral")
                    .and.emit("AddPositionCollateralRevert");
            });
            it("Try to remove collateral position with outdated account version", async function () {
                {
                    const { traceTree } = await locklift.tracing.trace(vault.setNewAccountCode());
                }
                const oldAccountVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(oldAccountVersion).to.be.eq(3);

                const posKey = await vault.account(user).then(res => res.positions().then(res => Number(res[0][0])));
                const { traceTree } = await locklift.tracing.trace(
                    vault.removeCollateral(user, 10 * USDT_DECIMALS, posKey, MARKET_IDX),
                );
                const newVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(newVersion).to.be.eq(4);
                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "3",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "4",
                    })
                    .and.call("revert_removeCollateral")
                    .and.emit("RemovePositionCollateralRevert");
            });
            it("Try to liquidate position with outdated account version", async function () {
                {
                    const { traceTree } = await locklift.tracing.trace(vault.setNewAccountCode());
                }
                const oldAccountVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(oldAccountVersion).to.be.eq(4);

                const posKey = await vault.account(user).then(res => res.positions().then(res => Number(res[0][0])));
                const { traceTree } = await locklift.tracing.trace(
                    vault.liquidatePositions([
                        [
                            MARKET_IDX,
                            {
                                positions: [{ positionKey: posKey, user: user.address }],
                                price: empty_price,
                            },
                        ],
                    ]),
                );
                const newVersion = await vault
                    .account(user)
                    .then(res => res.getVersion())
                    .then(Number);
                expect(newVersion).to.be.eq(5);
                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "4",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "5",
                    })
                    .and.call("revert_liquidatePositions")
                    .and.emit("LiquidatePositionRevert");
            });
            it("Try to open limit with outdated account version", async function () {
                const INITIAL_PRICE = 1000 * USDT_DECIMALS;
                await setPrice(ethUsdtMock, INITIAL_PRICE);
                await vault.deployGravixAccount(user);
                await vault.deployGravixAccount(user1);

                {
                    const { traceTree } = await locklift.tracing.trace(
                        vault.openLimitPosition({
                            limitType: LimitType.Limit,
                            callId: 0,
                            amount: 100 * USDT_DECIMALS,
                            triggerPrice: 1001 * 100,
                            leverage: LEVERAGE_DECIMALS,
                            positionType: PosType.Long,
                            marketIdx: 0,
                            fromWallet: userUsdtWallet,
                        }),
                        { allowedCodes: { compute: [null] } },
                    );
                    await traceTree.beautyPrint();
                }
                await locklift.tracing.trace(vault.setNewAccountCode());
                const accountDetailsBeforeUpgrade = await vault.account(user).then(res => res.getDetails());

                expect(unwrapAddresses(accountDetailsBeforeUpgrade)).to.be.deep.eq({
                    _currentVersion: "5",
                    _vault: vault.address.toString(),
                    _user: user.address.toString(),
                    _referrer: user1.address.toString(),
                    _grandReferrer: zeroAddress.toString(),
                    _referralBalance: "0",
                });
                const firstLimitOrderBeforeUpgrade = await vault
                    .account(user)
                    .then(res => res.contract.getFields().then(res => res.fields!.limitOrders))
                    .then(res => res[0]);
                const { traceTree } = await locklift.tracing.trace(
                    vault.openLimitPosition({
                        limitType: LimitType.Limit,
                        callId: 0,
                        amount: 100 * USDT_DECIMALS,
                        triggerPrice: 1001 * 100,
                        referrer: zeroAddress,
                        leverage: LEVERAGE_DECIMALS,
                        positionType: PosType.Long,
                        marketIdx: 0,
                        fromWallet: userUsdtWallet,
                    }),
                    { allowedCodes: { compute: [null] } },
                );
                const accountDetailsAfterUpgrade = await vault.account(user).then(res => res.getDetails());
                const firstLimitOrderAfterUpgrade = await vault
                    .account(user)
                    .then(res => res.contract.getFields().then(res => res.fields!.limitOrders))
                    .then(res => res[0]);
                expect(firstLimitOrderBeforeUpgrade[0]).to.be.eq(firstLimitOrderAfterUpgrade[0]);
                expect(unwrapAddresses(accountDetailsAfterUpgrade)).to.be.deep.eq({
                    _currentVersion: "6",
                    _vault: vault.address.toString(),
                    _user: user.address.toString(),
                    _referrer: user1.address.toString(),
                    _grandReferrer: zeroAddress.toString(),
                    _referralBalance: "0",
                });

                expect(traceTree)
                    .to.call("onGravixAccountRequestUpgrade")
                    .withNamedArgs({
                        _accountVersion: "5",
                    })
                    .and.call("upgrade")
                    .withNamedArgs({
                        newVersion: "6",
                    })
                    .and.call("revert_requestPendingLimitOrder")
                    .and.emit("LimitOrderPendingRequestRevert");
            });
        });
    });
});
