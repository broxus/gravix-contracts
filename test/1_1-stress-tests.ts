import { Account } from "locklift/everscale-client";
import { Address, Contract, getRandomNonce, lockliftChai, toNano, zeroAddress } from "locklift";
import chai, { expect } from "chai";
import BigNumber from "bignumber.js";
import { Token } from "./utils/wrappers/token";
import { bn } from "./utils/common";
import { GravixVault, MarketConfig, Oracle } from "./utils/wrappers/vault";
import { GravixVaultAbi, PairMockAbi, PriceNodeAbi, TokenRootUpgradeableAbi } from "../build/factorySource";
import { TokenWallet } from "./utils/wrappers/token_wallet";
import { getPrice, openMarketOrderWithTests, setPrice } from "./utils/orders";

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

    let user_usdt_wallet: TokenWallet;
    let user1_usdt_wallet: TokenWallet;
    let owner_usdt_wallet: TokenWallet;
    let user_stg_wallet: TokenWallet;

    // left - eth, right - usdt
    let eth_usdt_mock: Contract<PairMockAbi>;
    // left - btc, right - eth
    let btc_eth_mock: Contract<PairMockAbi>;

    const eth_addr = new Address("0:1111111111111111111111111111111111111111111111111111111111111111");
    const btc_addr = new Address("0:2222222222222222222222222222222222222222222222222222222222222222");

    const basic_config: MarketConfig = {
        priceSource: 0,
        maxLongsUSD: 10000_000 * USDT_DECIMALS, // 100k
        maxShortsUSD: 10000_000 * USDT_DECIMALS, // 100k
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
            user1 = locklift.deployments.getAccount("User1").account;
            vault = new GravixVault(locklift.deployments.getContract<GravixVaultAbi>("Vault"), owner);
            stg_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT"), owner);
            usdt_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT"), owner);
            eth_usdt_mock = locklift.deployments.getContract("ETH_USDT");
            user_usdt_wallet = await usdt_root.wallet(user);
            user1_usdt_wallet = await usdt_root.wallet(user1);
            owner_usdt_wallet = await usdt_root.wallet(owner);
        });

        describe("Liquidations stress", async function () {
            let market_idx: number;

            it("Add market without borrow/funding fee", async function () {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 0;
                new_config.fees.fundingBaseRatePerHour = 0;

                const oracle: Oracle = {
                    dex: {
                        targetToken: eth_addr,
                        path: [{ addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address }],
                    },
                    priceNode: { ticker: "", maxOracleDelay: 0, maxServerDelay: 0 },
                };

                await locklift.tracing.trace(vault.addMarkets([new_config]));
                market_idx = Number((await vault.contract.methods.getDetails({ answerId: 0 }).call())._marketCount) - 1;
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it("Test liquidation occurs correctly", async function () {
                const price = 1000 * USDT_DECIMALS;
                await setPrice(eth_usdt_mock, price);

                const collateral = 100 * USDT_DECIMALS;
                const leverage = 100000000;
                const pos_type = LONG_POS;
                const initial_price = Number(await getPrice(eth_usdt_mock));
                const market = (await vault.contract.methods.getMarket({ marketIdx: market_idx, answerId: 0 }).call())
                    ._market;

                const position = collateral * (leverage / 1000000);
                const position_in_asset = (position * PRICE_DECIMALS) / initial_price;
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
                const total_spread = bn(market.fees.baseSpreadRate).plus(dynamic_spread);
                const price_multiplier =
                    pos_type == 0 ? PERCENT_100.plus(total_spread) : PERCENT_100.minus(total_spread);
                const expected_price = price_multiplier.times(initial_price).idiv(PERCENT_100);

                const payload = (
                    await vault.contract.methods
                        .encodeMarketOrder({
                            marketIdx: market_idx,
                            positionType: pos_type,
                            leverage,
                            expectedPrice: expected_price.toString(),
                            maxSlippageRate: 1_000_000_000_000,
                            price: empty_price,
                            callId: getRandomNonce(),
                            referrer: zeroAddress,
                            nonce: 0,
                        })
                        .call()
                ).payload;
                for (let _ of Array.from({ length: 6 })) {
                    await locklift.transactions.waitFinalized(
                        user_usdt_wallet.multiTransfer(
                            Array.from({ length: 50 }, () => collateral),
                            vault.address,
                            payload,
                            toNano(2.1),
                        ),
                    );
                }
                const acc = await vault.account(user);
                const positions = await acc.positions();
                const view1 = await acc.getPositionView(positions[0][0] as unknown as number, price * 100, {
                    accLongUSDFundingPerShare: 0,
                    accShortUSDFundingPerShare: 0,
                });
                const new_price = bn(view1.positionView.liquidationPrice).minus(PRICE_DECIMALS);
                await setPrice(eth_usdt_mock, new_price.idiv(100).toFixed());
                // now try liquidate
                const { traceTree } = await locklift.tracing.trace(
                    vault.liquidatePositions([
                        [
                            market_idx,
                            {
                                price: empty_price,
                                positions: positions.map(([positionKey]) => ({
                                    user: user.address,
                                    positionKey: positionKey as unknown as number,
                                })),
                            },
                        ],
                    ]),
                    { raise: false },
                );
                console.log(`Gas used: ${traceTree?.totalGasUsed()}`);

                expect(traceTree).to.emit("LiquidatePosition").count(300);
            });
        });
    });
});
