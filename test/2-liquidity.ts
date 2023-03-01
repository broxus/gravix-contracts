import {bn, deployUser, setupPairMock, setupTokenRoot, setupVault, tryIncreaseTime} from "./utils/common";
import {Account} from 'locklift/everscale-client';
import {Token} from "./utils/wrappers/token";
import {TokenWallet} from "./utils/wrappers/token_wallet";
import {Address, Contract, getRandomNonce, lockliftChai, toNano, zeroAddress} from "locklift";
import chai, {expect, use} from "chai";
import {GravixVault, MarketConfig, Oracle} from "./utils/wrappers/vault";
import {PairMockAbi, PriceNodeAbi} from "../build/factorySource";
import {GravixAccount} from "./utils/wrappers/vault_acc";
import BigNumber from "bignumber.js";
import {closeOrder, openMarketOrder, setPrice, testMarketPosition, testPositionFunding} from "./utils/orders";

const logger = require("mocha-logger");
chai.use(lockliftChai);


describe('Testing liquidity pool mechanics', async function() {
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


  describe('Setup contracts', async function () {
    it('Deploy users', async function () {
      user = await deployUser(30);
      owner = await deployUser(30);
    });

    it('Deploy tokens', async function () {
      const token_name = `TOKEN_${getRandomNonce()}`;
      const stg_token_name = `stg${token_name}`;
      usdt_root = await setupTokenRoot(token_name, token_name, owner, 6);
      stg_root = await setupTokenRoot(stg_token_name, stg_token_name, owner, 6);

    });

    it('Mint tokens to users', async function () {
      owner_usdt_wallet = await usdt_root.mint(1000000000 * USDT_DECIMALS, owner);
      user_usdt_wallet = await usdt_root.mint(1000000000 * USDT_DECIMALS, user);
    });

    it('Deploy price node', async function() {
      const signer = await locklift.keystore.getSigner('0');

      const { contract } = await locklift.tracing.trace(locklift.factory.deployContract({
        contract: 'PriceNode',
        initParams: {deploy_nonce: getRandomNonce()},
        constructorParams: {
          _owner: owner.address,
          _daemonPubkey: `0x${signer?.publicKey}`,
          _oraclePubkey: `0x${signer?.publicKey}`
        },
        publicKey: signer?.publicKey as string,
        value: toNano(1)
      }));
      priceNode = contract;
    });

    it('Deploy Gravix Vault', async function () {
      vault = await setupVault(
        owner,
        owner,
        usdt_root.address,
        stg_root.address,
        owner.address,
        priceNode.address
      );

      // now transfer ownership of stgTOKEN to vault
      await stg_root.transferOwnership({address: vault.address} as Account);
    });

    it('Deploy pairs mocks', async function () {
      eth_usdt_mock = await setupPairMock();
      btc_eth_mock = await setupPairMock();
    });
  });

  describe('Running scenarios', async function() {
    it("Add market to vault", async function () {
      // eth market
      const oracle: Oracle = {
        chainlink: {chainID: 0, ticker: '', ttl: 0},
        dex: {
          targetToken: eth_addr,
          path: [{addr: eth_usdt_mock.address, leftRoot: eth_addr, rightRoot: usdt_root.address}]
        },
        priceNode: {ticker: ''}
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

      user_stg_wallet = await stg_root.wallet(user);
      const user_stg_bal = await user_stg_wallet.balance();
      expect(user_stg_bal.toString()).to.be.eq(deposit_amount.toString());
    });
  });
});
