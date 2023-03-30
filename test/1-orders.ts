import {bn} from "./utils/common";
import {Account} from 'locklift/everscale-client';
import {Token} from "./utils/wrappers/token";
import {TokenWallet} from "./utils/wrappers/token_wallet";
import {Address, Contract, lockliftChai} from "locklift";
import chai, {expect} from "chai";
import {GravixVault, MarketConfig, Oracle} from "./utils/wrappers/vault";
import {GravixVaultAbi, PairMockAbi, PriceNodeAbi, TokenRootUpgradeableAbi} from "../build/factorySource";
import {GravixAccount} from "./utils/wrappers/vault_acc";
import BigNumber from "bignumber.js";
import {closeOrder, openMarketOrder, setPrice, testMarketPosition, testPositionFunding} from "./utils/orders";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
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
        eventData: '',
        eventBlock: 0,
        eventIndex: 0,
        eventTransaction: 0,
        eventBlockNumber: 0
    }

    const empty_price = {
        price: 0,
        serverTime: 0,
        oracleTime: 0,
        ticker: '',
        signature: ''
    }

    let vault: GravixVault;
    let account: GravixAccount;
    let priceNode: Contract<PriceNodeAbi>;

    let user_usdt_wallet: TokenWallet;
    let owner_usdt_wallet: TokenWallet;
    let user_stg_wallet: TokenWallet;

    // left - eth, right - usdt
    let eth_usdt_mock: Contract<PairMockAbi>;
    // left - btc, right - eth
    let btc_eth_mock: Contract<PairMockAbi>;

    const eth_addr = new Address('0:1111111111111111111111111111111111111111111111111111111111111111');
    const btc_addr = new Address('0:2222222222222222222222222222222222222222222222222222222222222222');

    const basic_config: MarketConfig = {
        priceSource: 1,
        maxLongsUSD: 100_000 * USDT_DECIMALS, // 100k
        maxShortsUSD: 100_000 * USDT_DECIMALS, // 100k
        noiWeight: 100,
        maxLeverage: 10000, // 100x
        depthAsset: 15 * USDT_DECIMALS, // 25k
        fees: {
            openFeeRate: 1000000000, // 0.1%
            closeFeeRate: 1000000000, // 0.1%
            baseSpreadRate: 1000000000, // 0.1%
            baseDynamicSpreadRate: 1000000000, // 0.1%
            borrowBaseRatePerHour: 0, // disable by default
            fundingBaseRatePerHour: 0 // disable by default
        },
        scheduleEnabled: false,
        workingHours: []
    }

    describe('Setup contracts', async function() {
        it('Run fixtures', async function() {
           await locklift.deployments.fixture();

           owner = locklift.deployments.getAccount('Owner').account;
           user = locklift.deployments.getAccount('User').account;
           vault = new GravixVault(locklift.deployments.getContract<GravixVaultAbi>('Vault'), owner);
           stg_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>('StgUSDT'), owner);
           usdt_root = new Token(locklift.deployments.getContract<TokenRootUpgradeableAbi>('USDT'), owner);
           eth_usdt_mock = locklift.deployments.getContract('ETH_USDT');
           user_usdt_wallet = await usdt_root.wallet(user);
           owner_usdt_wallet = await usdt_root.wallet(user);
        });
    })

    describe("Running scenarios", async function () {
        let pool_balance: BigNumber;

        it("Add market to vault", async function () {
            // eth market
            const oracle: Oracle = {
                chainlink: {chainID: 0, ticker: '', ttl: 0},
                dex: {
                    targetToken: eth_addr,
                    path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
                },
                priceNode: {ticker: '', maxOracleDelay: 0, maxServerDelay: 0}
            }

            await locklift.tracing.trace(vault.addMarkets([basic_config]));
            await locklift.tracing.trace(vault.setOracles([[0, oracle]]));
        });

        it('Provide liquidity', async function () {
            locklift.tracing.setAllowedCodesForAddress(user.address, {compute: [60]});

            const deposit_amount = 10000000 * USDT_DECIMALS;
            const {traceTree} = await locklift.tracing.trace(vault.addLiquidity(user_usdt_wallet, deposit_amount));

            expect(traceTree).to
                .emit("LiquidityPoolDeposit")
                .withNamedArgs({
                    usdt_amount_in: deposit_amount.toString(),
                    stg_usdt_amount_out: deposit_amount.toString()
                });

            const details = await vault.details();
            expect(details._stgUsdtSupply).to.be.eq(deposit_amount.toString());
            expect(details._poolBalance).to.be.eq(deposit_amount.toString());
            pool_balance = bn(deposit_amount);

            user_stg_wallet = await stg_root.wallet(user);
            const user_stg_bal = await user_stg_wallet.balance();
            expect(user_stg_bal.toString()).to.be.eq(deposit_amount.toString());
        });

        describe('Basic scenarios: open fee, pnl, close fee, spreads, liq price checked', async function () {
            const market_idx = 0;

            describe('Test solo long positions', async function () {
                it('Pnl+, 1x leverage, open/close 1000$/1100$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100,
                        1000 * USDT_DECIMALS,
                        1100 * USDT_DECIMALS
                    );
                });

                it('Pnl+, 10x leverage, open/close 1000$/1500$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        1000,
                        1000 * USDT_DECIMALS,
                        1500 * USDT_DECIMALS
                    );
                });

                it('Pnl+, 100x leverage, open/close 1000$/2000$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        10000,
                        1000 * USDT_DECIMALS,
                        2000 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 1x leverage, open/close 1000$/500$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100,
                        1000 * USDT_DECIMALS,
                        500 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 10x leverage, open/close 1000$/950$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        1000,
                        1000 * USDT_DECIMALS,
                        950 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 100x leverage, open/close 1000$/995$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        10000,
                        1000 * USDT_DECIMALS,
                        995 * USDT_DECIMALS
                    );
                });
            });

            describe('Test solo short positions', async function () {
                it('Pnl+, 1x leverage, open/close 1000$/900$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100,
                        1000 * USDT_DECIMALS,
                        900 * USDT_DECIMALS
                    );
                });

                it('Pnl+, 10x leverage, open/close 1000$/650$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        1000,
                        1000 * USDT_DECIMALS,
                        650 * USDT_DECIMALS
                    );
                });

                it('Pnl+, 100x leverage, open/close 1000$/300$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        10000,
                        1000 * USDT_DECIMALS,
                        300 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 1x leverage, open/close 1000$/1850$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100,
                        1000 * USDT_DECIMALS,
                        1850 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 10x leverage, open/close 1000$/1050$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        1000,
                        1000 * USDT_DECIMALS,
                        1050 * USDT_DECIMALS
                    );
                });

                it('Pnl-, 100x leverage, open/close 1000$/1005$', async function () {
                    await testMarketPosition(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        10000,
                        1000 * USDT_DECIMALS,
                        1005 * USDT_DECIMALS
                    );
                });
            });

            describe('Mixed case', async function() {
                let long_pos_key: number, long_pos2_key: number;
                let short_pos_key: number, short_pos2_key: number;

                it('Opening positions at 1000$', async function() {
                    await setPrice(eth_usdt_mock, 1000 * USDT_DECIMALS);
                    long_pos_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100
                    );
                    short_pos_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100
                    );
                    long_pos2_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        100
                    );
                    short_pos2_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        100
                    );
                });

                it('Closing positions at 1100$/900$', async function() {
                    await setPrice(eth_usdt_mock, 1100 * USDT_DECIMALS);
                    await closeOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        long_pos_key
                    );
                    await closeOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        short_pos_key
                    );

                    await setPrice(eth_usdt_mock, 900 * USDT_DECIMALS);
                    await closeOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        long_pos2_key
                    );
                    await closeOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        short_pos2_key
                    );
                });
            });
        });

        describe('Advanced scenarios: funding and borrow fee checked', async function() {
            let market_idx: number;
            let base_funding = 1000000000; // 0.1%

            it('Add market with borrow rate > 0', async function() {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 1000000000; // 0.1% per hour
                new_config.fees.fundingBaseRatePerHour = 0; // 0.1%

                const oracle: Oracle = {
                    chainlink: {chainID: 0, ttl: 0, ticker: ''},
                    dex: {
                        targetToken: eth_addr,
                        path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
                    },
                    priceNode: {ticker: '', maxOracleDelay: 0, maxServerDelay: 0}
                }

                market_idx = 1;
                await locklift.tracing.trace(vault.addMarkets([new_config]));
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it('Testing borrow fee', async function() {
                await testMarketPosition(
                    vault,
                    eth_usdt_mock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    LONG_POS,
                    100 * USDT_DECIMALS,
                    100,
                    1000 * USDT_DECIMALS,
                    1100 * USDT_DECIMALS,
                    86400 // 1 day
                );

                await testMarketPosition(
                    vault,
                    eth_usdt_mock,
                    user,
                    user_usdt_wallet,
                    market_idx,
                    SHORT_POS,
                    100 * USDT_DECIMALS,
                    100,
                    1000 * USDT_DECIMALS,
                    1100 * USDT_DECIMALS,
                    86400 // 1 day
                );
            });

            it('Add market with funding rate > 0', async function() {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 0;
                new_config.fees.fundingBaseRatePerHour = base_funding; // 0.1%

                const oracle: Oracle = {
                    chainlink: {chainID: 0, ttl: 0, ticker: ''},
                    dex: {
                        targetToken: eth_addr,
                        path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
                    },
                    priceNode: {ticker: '', maxOracleDelay: 0, maxServerDelay: 0}
                }

                market_idx = 2;
                await locklift.tracing.trace(vault.addMarkets([new_config]));
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            describe('Testing funding fee', async function() {
                it('Solo long position', async function() {
                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      LONG_POS,
                      100 * USDT_DECIMALS,
                      10000,
                      1000 * USDT_DECIMALS,
                      3600
                    );
                });

                it('Solo short position', async function() {
                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      10000,
                      1000 * USDT_DECIMALS,
                      3600
                    );
                });

                it('Longs > shorts', async function() {
                    // big long
                    const pos_key = await openMarketOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      LONG_POS,
                      100 * USDT_DECIMALS,
                      10000
                    );

                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      100,
                      1000 * USDT_DECIMALS,
                      7200
                    );

                    await closeOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      pos_key
                    );
                });

                it('Shorts > longs', async function() {
                    // big short
                    const pos_key = await openMarketOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      10000
                    );

                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      LONG_POS,
                      100 * USDT_DECIMALS,
                      100,
                      1000 * USDT_DECIMALS,
                      7200
                    );

                    await closeOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      pos_key
                    );
                })
            });
        });

        describe('Liquidations', async function() {
            let market_idx: number;

            it('Add market without borrow/funding fee', async function() {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 0;
                new_config.fees.fundingBaseRatePerHour = 0;

                const oracle: Oracle = {
                    chainlink: {chainID: 0, ttl: 0, ticker: ''},
                    dex: {
                        targetToken: eth_addr,
                        path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
                    },
                    priceNode: {ticker: '', maxOracleDelay: 0, maxServerDelay: 0}
                }

                await locklift.tracing.trace(vault.addMarkets([new_config]));
                market_idx = Number((await vault.contract.methods.getDetails({answerId: 0}).call())._marketCount) - 1;
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it('Test liquidation occurs correctly', async function() {
                const price = 1000 * USDT_DECIMALS;
                await setPrice(eth_usdt_mock, price);

                const pos_key1 = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  10000
                );

                const pos_key2 = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  5000
                );

                const acc = await vault.account(user);
                const view1 = await acc.getPositionView(
                  pos_key1, price * 100, {accLongUSDFundingPerShare: 0, accShortUSDFundingPerShare: 0}
                );
                const view2 = await acc.getPositionView(
                  pos_key2, price * 100, {accLongUSDFundingPerShare: 0, accShortUSDFundingPerShare: 0}
                );

                // move price to liquidate first one, but don't touch second one
                // just 1$ down 1st position liq price
                const new_price = bn(view1.position_view.liquidationPrice).minus(PRICE_DECIMALS);
                await setPrice(eth_usdt_mock, new_price.idiv(100).toFixed());

                const view11 = await acc.getPositionView(
                  pos_key1, new_price.toFixed(), {accLongUSDFundingPerShare: 0, accShortUSDFundingPerShare: 0}
                );
                const view22 = await acc.getPositionView(
                  pos_key2, new_price.toFixed(), {accLongUSDFundingPerShare: 0, accShortUSDFundingPerShare: 0}
                );

                expect(view11.position_view.liquidate).to.be.true;
                expect(view22.position_view.liquidate).to.be.false;

                // now try liquidate
                const {traceTree} = await locklift.tracing.trace(vault.liquidatePositions(
                  [
                    [
                      market_idx,
                        {
                            eventData: empty_event,
                            price: empty_price,
                            positions: [{user: user.address, positionKey: pos_key1}, {user: user.address, positionKey: pos_key2}]
                        }
                    ]
                  ]
                ));
                expect(traceTree).to
                  .emit('LiquidatePosition')
                  .withNamedArgs({
                      user: user.address,
                      position_key: pos_key1
                  });
                expect(traceTree).to
                  .emit('LiquidatePositionRevert')
                  .withNamedArgs({
                      user: user.address,
                      position_key: pos_key2
                  });

                // now liquidate 2nd position
                const new_price2 = bn(view2.position_view.liquidationPrice).minus(PRICE_DECIMALS);
                await setPrice(eth_usdt_mock, new_price2.idiv(100).toFixed());

                const {traceTree: traceTree2} = await locklift.tracing.trace(vault.liquidatePositions(
                  [
                      [
                          market_idx,
                          {
                              eventData: empty_event,
                              price: empty_price,
                              positions: [{user: user.address, positionKey: pos_key2}]
                          }
                      ]
                  ]
                ));
                expect(traceTree2).to
                  .emit('LiquidatePosition')
                  .withNamedArgs({
                      user: user.address,
                      position_key: pos_key2
                  });
            });

            it('Add market with borrow fee > 0', async function() {
                let new_config = basic_config;
                new_config.fees.borrowBaseRatePerHour = 1000000000; // 0.1% per hour
                new_config.fees.fundingBaseRatePerHour = 0;

                const oracle: Oracle = {
                    chainlink: {chainID: 0, ttl: 0, ticker: ''},
                    dex: {
                        targetToken: eth_addr,
                        path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
                    },
                    priceNode: {ticker: '', maxOracleDelay: 0, maxServerDelay: 0}
                }

                await locklift.tracing.trace(vault.addMarkets([new_config]));
                market_idx = Number((await vault.contract.methods.getDetails({answerId: 0}).call())._marketCount) - 1;
                await locklift.tracing.trace(vault.setOracles([[market_idx, oracle]]));
            });

            it('Test liquidation price moves when borrow fee accumulate', async function() {
                const price = 1000 * USDT_DECIMALS;
                await setPrice(eth_usdt_mock, price);

                const pos_key = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  10000
                );
            });
        });

        describe('Edit collateral', async function() {
            let pos_key: number;

            describe('Add collateral', async function() {
                it('Open position', async function() {
                    await setPrice(eth_usdt_mock, 1000 * USDT_DECIMALS);
                    pos_key = await openMarketOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      0,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      100
                    );
                });

                it("Add collateral", async function() {
                    const account = await vault.account(user);
                    const pos = (await account.contract.methods.getPosition({pos_key: pos_key, answerId: 0}).call()).position;

                    const amount = 50000000;
                    const {traceTree} = await locklift.tracing.trace(
                      vault.addCollateral(user_usdt_wallet, user, amount, pos_key, 0)
                    );

                    const old_col = bn(pos.initialCollateral).minus(pos.openFee);
                    const new_col = old_col.plus(amount);
                    const leveraged_position_usd = old_col.times(pos.leverage).idiv(100);
                    const new_leverage = leveraged_position_usd.times(100).idiv(new_col);

                    expect(traceTree).to
                      .emit('AddPositionCollateral')
                      .withNamedArgs({
                          amount: amount.toFixed(),
                          updated_pos: {
                              leverage: new_leverage.toFixed()
                          }
                      });

                    const pos2 = (await account.contract.methods.getPosition({pos_key: pos_key, answerId: 0}).call()).position;
                    expect(pos2.initialCollateral).to.be.eq(bn(pos.initialCollateral).plus(amount).toFixed());
                    expect(pos2.leverage).to.be.eq(new_leverage.toFixed());

                });
            });

            describe('Remove collateral', async function() {
                it('Open position', async function() {
                    pos_key = await openMarketOrder(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      0,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      100
                    );
                });

                it("Remove collateral", async function() {
                    const account = await vault.account(user);
                    const pos = (await account.contract.methods.getPosition({pos_key: pos_key, answerId: 0}).call()).position;

                    const amount = 50000000;
                    const {traceTree} = await locklift.tracing.trace(
                      vault.removeCollateral(user, amount, pos_key, 0, 1)
                    );

                    const old_col = bn(pos.initialCollateral).minus(pos.openFee);
                    const new_col = old_col.minus(amount);
                    const leveraged_position_usd = old_col.times(pos.leverage).idiv(100);
                    const new_leverage = leveraged_position_usd.times(100).idiv(new_col);

                    expect(traceTree).to
                      .emit('RemovePositionCollateral')
                      .withNamedArgs({
                          amount: amount.toFixed(),
                          updated_pos: {
                              leverage: new_leverage.toFixed()
                          }
                      });

                    const pos2 = (await account.contract.methods.getPosition({pos_key: pos_key, answerId: 0}).call()).position;
                    expect(pos2.initialCollateral).to.be.eq(bn(pos.initialCollateral).minus(amount).toFixed());
                    expect(pos2.leverage).to.be.eq(new_leverage.toFixed());
                });
            });
        });
    });
});
