import {bn} from "./utils/common";
import {Account} from 'locklift/everscale-client';
import {Token} from "./utils/wrappers/token";
import {TokenWallet} from "./utils/wrappers/token_wallet";
import {Address, Contract, lockliftChai, toNano, zeroAddress} from "locklift";
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
    const LEVERAGE_DECIMALS = 10**6;
    const PERCENT_100 = bn(1_000_000_000_000);
    const REF_OPEN_FEE_RATE = PERCENT_100.idiv(10);
    const REF_CLOSE_FEE_RATE = PERCENT_100.idiv(10);
    const REF_PNL_FEE_RATE = PERCENT_100.idiv(100);
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
        maxLeverage: 100_000_000, // 100x
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
           owner_usdt_wallet = await usdt_root.wallet(owner);
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

        describe.skip('Basic scenarios: open fee, pnl, close fee, spreads, liq price checked', async function () {
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
                        LEVERAGE_DECIMALS,
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
                        10 * LEVERAGE_DECIMALS,
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
                        100 * LEVERAGE_DECIMALS,
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
                        LEVERAGE_DECIMALS,
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
                        10 * LEVERAGE_DECIMALS,
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
                        100 * LEVERAGE_DECIMALS,
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
                        LEVERAGE_DECIMALS,
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
                        10 * LEVERAGE_DECIMALS,
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
                        100 * LEVERAGE_DECIMALS,
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
                        LEVERAGE_DECIMALS,
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
                        10 * LEVERAGE_DECIMALS,
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
                        100 * LEVERAGE_DECIMALS,
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
                        LEVERAGE_DECIMALS
                    );
                    short_pos_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS
                    );
                    long_pos2_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        LONG_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS
                    );
                    short_pos2_key = await openMarketOrder(
                        vault,
                        eth_usdt_mock,
                        user,
                        user_usdt_wallet,
                        market_idx,
                        SHORT_POS,
                        100 * USDT_DECIMALS,
                        LEVERAGE_DECIMALS
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

        describe.skip('Advanced scenarios: funding and borrow fee checked', async function() {
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
                    LEVERAGE_DECIMALS,
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
                    LEVERAGE_DECIMALS,
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
                      100 * LEVERAGE_DECIMALS,
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
                      100 * LEVERAGE_DECIMALS,
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
                      100 * LEVERAGE_DECIMALS
                    );

                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      SHORT_POS,
                      100 * USDT_DECIMALS,
                      1000000,
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
                      100 * LEVERAGE_DECIMALS
                    );

                    await testPositionFunding(
                      vault,
                      eth_usdt_mock,
                      user,
                      user_usdt_wallet,
                      market_idx,
                      LONG_POS,
                      100 * USDT_DECIMALS,
                      LEVERAGE_DECIMALS,
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

        describe.skip('Liquidations', async function() {
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
                  100000000
                );

                const pos_key2 = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  50000000
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
                  100000000
                );
            });
        });

        describe.skip('Edit collateral', async function() {
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
                      LEVERAGE_DECIMALS
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
                      LEVERAGE_DECIMALS
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

        describe.skip('Max PNL rate', async function() {
            const market_idx = 0;
            let long_pos_key: number;

            it('Set max PNL rate to 200%', async function() {
                await locklift.tracing.trace(vault.contract.methods.setMaxPnlRate({
                    new_max_rate: PERCENT_100.times(2).toFixed(),
                    meta: {call_id: 0, nonce: 0, send_gas_to: user.address}
                }).send({amount: toNano(3), from: owner.address}));
            });

            it('Pnl+, 100x leverage, open at 1000$', async function () {
                await setPrice(eth_usdt_mock, 1000 * USDT_DECIMALS);
                long_pos_key = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  100 * LEVERAGE_DECIMALS
                );
            });

            it('Closing positions at 5000$', async function() {
                await setPrice(eth_usdt_mock, 5000 * USDT_DECIMALS);
                await closeOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  long_pos_key
                );
            });
        });

        describe('Referrals', async function() {
            const market_idx = 0;
            let user1_long_pos_key: number;
            let owner_long_pos_key: number;

            it('User set referrer on position open', async function() {
                await setPrice(eth_usdt_mock, 1000 * USDT_DECIMALS);
                await locklift.tracing.trace(vault.contract.methods.deployGravixAccount({
                    answerId: 0, user: owner.address, meta: {call_id: 0, send_gas_to: owner.address, nonce: 0}
                }).send({from: owner.address, amount: toNano(1)}));

                user1_long_pos_key = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  user,
                  user_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  LEVERAGE_DECIMALS,
                  owner.address // owner as a referrer
                );

                const user_acc = await vault.account(user);
                // get position
                // @ts-ignore
                const [pos_key, pos] = (await user_acc.positions()).pop();
                const expected_ref_fee = bn(pos.openFee).times(REF_OPEN_FEE_RATE).idiv(PERCENT_100);

                const user_details = await user_acc.contract.methods.getDetails({answerId: 0}).call();
                // check referrer is set correctly
                expect(user_details._referrer.toString()).to.be.eq(owner.address.toString());
                // check event is emitted
                const event = (await vault.getEvent('ReferralPayment'))! as any;
                expect(event.referrer.toString()).to.be.eq(owner.address.toString());
                expect(event.referral.toString()).to.be.eq(user.address.toString());
                expect(event.amount).to.be.eq(expected_ref_fee.toFixed());

                const owner_acc = await vault.account(owner);
                const owner_details = await owner_acc.contract.methods.getDetails({answerId: 0}).call();
                // check referrer got his balance
                expect(owner_details._referralBalance).to.be.eq(event.amount);
            });

            it('User set referrer on position close', async function() {
                // open position without referrer
                owner_long_pos_key = await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  owner,
                  owner_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  LEVERAGE_DECIMALS
                );
                // user doesnt have referrer
                const owner_acc = await vault.account(owner);
                const owner_details = await owner_acc.contract.methods.getDetails({answerId: 0}).call();
                // check referrer got his balance
                expect(owner_details._referrer.toString()).to.be.eq(zeroAddress.toString());

                // close position with referrer
                await closeOrder(
                  vault,
                  eth_usdt_mock,
                  owner,
                  owner_usdt_wallet,
                  owner_long_pos_key,
                  user.address // another user as a referrer
                );
                const owner_details_2 = await owner_acc.contract.methods.getDetails({answerId: 0}).call();
                // check referrer is set correctly
                expect(owner_details_2._referrer.toString()).to.be.eq(user.address.toString());

                // calculate expected ref fees
                const close_event = await vault.getEvent('ClosePosition') as any;
                const pos_view = close_event.position_view;
                const expected_ref_fee_close = bn(pos_view.closeFee).times(REF_CLOSE_FEE_RATE).idiv(PERCENT_100);
                const pnl_with_fees = bn(pos_view.pnl).minus(pos_view.borrowFee).minus(pos_view.fundingFee).times(-1);
                const expected_ref_fee_pnl = pnl_with_fees.times(REF_PNL_FEE_RATE).idiv(PERCENT_100);

                // check event is emitted (we have 2 events in this tx, but 1 check is enough)
                const ref_event = (await vault.getEvent('ReferralPayment'))! as any;
                expect(ref_event.referrer.toString()).to.be.eq(user.address.toString());
                expect(ref_event.referral.toString()).to.be.eq(owner.address.toString());

                const user_acc = await vault.account(user);
                const user_details = await user_acc.contract.methods.getDetails({answerId: 0}).call();
                // check user got his ref balance
                expect(user_details._referralBalance).to.be.eq(expected_ref_fee_close.plus(expected_ref_fee_pnl).toFixed());
            });

            it('User try to change existing referrer', async function() {
                const owner_acc = await vault.account(owner);
                const owner_details = await owner_acc.contract.methods.getDetails({answerId: 0}).call();
                // remember our original referrer

                // try to change referrer
                await openMarketOrder(
                  vault,
                  eth_usdt_mock,
                  owner,
                  owner_usdt_wallet,
                  market_idx,
                  LONG_POS,
                  100 * USDT_DECIMALS,
                  LEVERAGE_DECIMALS,
                  vault.address // any address could be here, we just check original referrer is not changed
                );

                const owner_details_2 = await owner_acc.contract.methods.getDetails({answerId: 0}).call();
                expect(owner_details._referrer.toString()).to.be.eq(owner_details_2._referrer.toString());
            });

            it('Referrer withdraw his referral balance', async function() {
                const user_acc = await vault.account(user);
                const user_details = await user_acc.contract.methods.getDetails({answerId: 0}).call();

                const {traceTree} = await locklift.tracing.trace(
                  vault.contract.methods.withdrawReferralBalance(
                    {meta: {call_id: 0, send_gas_to: user.address, nonce: 0}}
                  ).send({from: user.address, amount: toNano(2.5)})
                );

                expect(traceTree).to
                  .emit('ReferralBalanceWithdraw')
                  .withNamedArgs({
                    user: user.address.toString(),
                    amount: user_details._referralBalance.toString()
                  });

                // check ref balance is zero
                const user_details_2 = await user_acc.contract.methods.getDetails({answerId: 0}).call();
                expect(user_details_2._referralBalance).to.be.eq('0');
            });
        });
    });
});
