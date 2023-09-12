import { bn } from "./utils/common";
import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { Address, Contract, lockliftChai, toNano, WalletTypes, zeroAddress } from "locklift";
import chai, { expect } from "chai";
import { GravixVault, MarketConfig, Oracle } from "./utils/wrappers/vault";
import { GravixVaultAbi, PairMockAbi, PriceNodeAbi, TokenRootUpgradeableAbi } from "../build/factorySource";
import { GravixAccount } from "./utils/wrappers/vault_acc";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing liquidity pool mechanics", async function () {
    let user: Account;
    let owner: Account;

    let usdt_root: Token;
    let stg_root: Token;
    const USDT_DECIMALS = 10 ** 6;
    const PRICE_DECIMALS = 10 ** 8;
    const PERCENT_100 = bn(1_000_000_000_000);
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

    let priceNode: Contract<PriceNodeAbi>;
    let vault: GravixVault;
    let account: GravixAccount;

    let user_usdt_wallet: TokenWallet;
    let owner_usdt_wallet: TokenWallet;
    let user_stg_wallet: TokenWallet;

    // left - eth, right - usdt
    let eth_usdt_mock: Contract<PairMockAbi>;
    // left - btc, right - eth
    let btc_eth_mock: Contract<PairMockAbi>;

    const eth_addr = new Address("0:1111111111111111111111111111111111111111111111111111111111111111");
    const btc_addr = new Address("0:2222222222222222222222222222222222222222222222222222222222222222");

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

            owner = locklift.deployments.getAccount("Owner").account;
            user = locklift.deployments.getAccount("User").account;
            const { account: limitBot } = locklift.deployments.getAccount("LimitBot");
            vault = new GravixVault(locklift.deployments.getContract<GravixVaultAbi>("Vault"), owner, limitBot.address);
            stg_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT"), owner);
            usdt_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT"), owner);
            eth_usdt_mock = locklift.deployments.getContract("ETH_USDT");
            user_usdt_wallet = await usdt_root.wallet(user);
            owner_usdt_wallet = await usdt_root.wallet(user);
            priceNode = locklift.deployments.getContract<PriceNodeAbi>("PriceNode");
        });
    });

    describe("Running scenarios", async function () {
        describe("Price node functionality check", async function () {
            it("Setup price node", async function () {
                await locklift.tracing.trace(
                    priceNode.methods
                        .setTickerConfigs({
                            configs: [{ ticker: "BTC / USD", enabled: true, maxOracleDelay: 20, maxServerDelay: 15 }],
                        })
                        .send({ from: owner.address, amount: toNano(1) }),
                );

                await locklift.tracing.trace(
                    priceNode.methods
                        .setMaxActionsPerTx({ newMax: 2 })
                        .send({ from: owner.address, amount: toNano(1) }),
                );
            });

            it("Send requests", async function () {
                const { traceTree } = await locklift.tracing.trace(
                    priceNode.methods
                        .makeRequest({
                            ticker: "BTC / USD",
                        })
                        .send({ from: user.address, amount: toNano(2) }),
                );
                await locklift.tracing.trace(
                    priceNode.methods
                        .makeRequest({
                            ticker: "BTC / USD",
                        })
                        .send({ from: user.address, amount: toNano(2) }),
                );
                await locklift.tracing.trace(
                    priceNode.methods
                        .makeRequest({
                            ticker: "BTC / USD",
                        })
                        .send({ from: user.address, amount: toNano(2) }),
                );
            });

            it("Resolve request", async function () {
                const signer = await locklift.keystore.getSigner("0");

                const time = Math.ceil(locklift.testing.getCurrentTime() / 1000) - 1;

                const price = 100000000000;
                const ticker = "BTC / USD";
                const data = await locklift.provider.packIntoCell({
                    structure: [
                        { name: "price", type: "uint128" },
                        { name: "serverUpdateTime", type: "uint32" },
                        { name: "oracleUpdateTime", type: "uint32" },
                        { name: "ticker", type: "string" },
                    ] as const,
                    data: { ticker: ticker, serverUpdateTime: time, oracleUpdateTime: time, price: price },
                });
                const boc_hash = await locklift.provider.getBocHash(data.boc);
                const signature = await locklift.provider.signDataRaw({
                    publicKey: signer?.publicKey as string,
                    data: boc_hash,
                });
                console.log(signature);
                // const sign_ext = '5a9cf7b5289e9b272ddeedad92badd07b0e0235938b08ff5b571e465ff59a591';
                // const high = `0x${sign_ext.slice(0, sign_ext.length / 2)}`;
                // const low = `0x${sign_ext.slice(sign_ext.length / 2)}`;

                const cell = await locklift.provider.packIntoCell({
                    structure: [
                        { name: "part1", type: "uint256" },
                        { name: "part2", type: "uint256" },
                    ] as const,
                    data: { part1: signature.signatureParts.high, part2: signature.signatureParts.low },
                });

                const res = await priceNode.methods
                    .checkSign({
                        p: price,
                        t1: time,
                        t2: time,
                        tick: ticker,
                        signature: cell.boc,
                    })
                    .call();

                const res2 = await priceNode.methods
                    .validatePrice({
                        price: {
                            price: price,
                            ticker: ticker,
                            serverTime: time,
                            oracleTime: time,
                            signature: cell.boc,
                        },
                    })
                    .call();
                // console.log(res2);

                const { traceTree } = await locklift.tracing.trace(
                    priceNode.methods
                        .resolveRequests({
                            prices: [
                                {
                                    price: price,
                                    ticker: ticker,
                                    serverTime: time,
                                    oracleTime: time,
                                    signature: cell.boc,
                                },
                            ],
                        })
                        .sendExternal({ publicKey: signer?.publicKey as string }),
                    { allowedCodes: { compute: [60] } },
                );
            });
        });

        describe("Open position with price node", async function () {
            it("Add market to vault", async function () {
                // eth market
                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: "BTC / USD", maxOracleDelay: 10, maxServerDelay: 10 },
                };

                await locklift.tracing.trace(vault.addMarkets([basic_config]));
                await locklift.tracing.trace(vault.setOracles([[0, oracle]]));
            });

            it("Provide liquidity", async function () {
                locklift.tracing.setAllowedCodesForAddress(user.address, { compute: [60] });

                const deposit_amount = 10000000 * USDT_DECIMALS;
                const { traceTree } = await locklift.tracing.trace(
                    vault.addLiquidity(user_usdt_wallet, deposit_amount),
                );

                expect(traceTree).to.emit("LiquidityPoolDeposit").withNamedArgs({
                    usdtAmountIn: deposit_amount.toString(),
                    stgUsdtAmountOut: deposit_amount.toString(),
                });

                const details = await vault.details();
                expect(details._poolAssets.stgUsdtSupply).to.be.eq(deposit_amount.toString());
                expect(details._poolAssets.balance).to.be.eq(deposit_amount.toString());

                user_stg_wallet = await stg_root.wallet(user);
                const user_stg_bal = await user_stg_wallet.balance();
                expect(user_stg_bal.toString()).to.be.eq(deposit_amount.toString());
            });

            it("Open position request", async function () {
                const { traceTree } = await locklift.tracing.trace(
                    vault.openMarketPosition(
                        user_usdt_wallet,
                        10000000,
                        0,
                        0,
                        100,
                        1000000000,
                        1000000000000,
                        zeroAddress,
                        1,
                    ),
                    { allowedCodes: { compute: [null] } },
                );
            });

            it("Resolve request", async function () {
                const signer = await locklift.keystore.getSigner("0");

                const time = Math.ceil(locklift.testing.getCurrentTime() / 1000) - 1;

                const price = 1000000000;
                const ticker = "BTC / USD";
                const data = await locklift.provider.packIntoCell({
                    structure: [
                        { name: "price", type: "uint128" },
                        { name: "serverUpdateTime", type: "uint32" },
                        { name: "oracleUpdateTime", type: "uint32" },
                        { name: "ticker", type: "string" },
                    ] as const,
                    data: { ticker: ticker, serverUpdateTime: time, oracleUpdateTime: time, price: price },
                });
                const boc_hash = await locklift.provider.getBocHash(data.boc);
                const signature = await locklift.provider.signDataRaw({
                    publicKey: signer?.publicKey as string,
                    data: boc_hash,
                });
                const cell = await locklift.provider.packIntoCell({
                    structure: [
                        { name: "part1", type: "uint256" },
                        { name: "part2", type: "uint256" },
                    ] as const,
                    data: { part1: signature.signatureParts.high, part2: signature.signatureParts.low },
                });

                const res = await priceNode.methods
                    .checkSign({
                        p: price,
                        t1: time,
                        t2: time,
                        tick: ticker,
                        signature: cell.boc,
                    })
                    .call();
                // console.log(res);

                const res2 = await priceNode.methods
                    .validatePrice({
                        price: {
                            price: price,
                            ticker: ticker,
                            serverTime: time,
                            oracleTime: time,
                            signature: cell.boc,
                        },
                    })
                    .call();
                // console.log(res2);

                const { traceTree } = await locklift.tracing.trace(
                    priceNode.methods
                        .resolveRequests({
                            prices: [
                                {
                                    price: price,
                                    ticker: ticker,
                                    serverTime: time,
                                    oracleTime: time,
                                    signature: cell.boc,
                                },
                            ],
                        })
                        .sendExternal({ publicKey: signer?.publicKey as string }),
                );
            });
        });
    });
});
