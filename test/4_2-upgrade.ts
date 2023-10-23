import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { Address, Contract, lockliftChai, toNano } from "locklift";
import chai, { expect } from "chai";
import { GravixAccountPrevVersionAbi, GravixVaultAbi, GravixVaultPrevVersionAbi } from "../build/factorySource";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let owner: Account;
    let user: Account;
    let user1: Account;
    let openMarketOrderBaseValue: string;
    let openLimitOrderBaseValue: string;

    let stg_root: Token;
    const USDT_DECIMALS = 10 ** 6;
    const LEVERAGE_DECIMALS = 10 ** 6;

    const LONG_POS = 0;

    const empty_price = {
        price: 0,
        serverTime: 0,
        oracleTime: 0,
        ticker: "",
        signature: "",
    };

    let vault: Contract<GravixVaultAbi>;
    let prevVaultState: Contract<GravixVaultPrevVersionAbi>;
    let prevAccountState: Contract<GravixAccountPrevVersionAbi>;

    const MARKET_IDX = 0;
    describe("Setup contracts", async function () {
        it("Run fixtures", async function () {
            // await locklift.deployments.fixture();
            prevVaultState = locklift.factory.getDeployedContract(
                "GravixVaultPrevVersion",
                new Address("0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113"),
            );
            const prevVaultDetails = await prevVaultState.methods.getDetails({ answerId: 0 }).call();
            prevAccountState = locklift.factory.getDeployedContract(
                "GravixAccountPrevVersion",
                new Address("0:0b8f78c747010b6fe7f164c84614808ee6ca0d55b55644726225be758f1e6641"),
            );
            const prevAccountDetails = await prevAccountState.methods.getDetails({ answerId: 0 }).call();
            owner = locklift.network.insertWallet(prevVaultDetails._owner);
            user = locklift.network.insertWallet(prevAccountDetails._user);
        });
    });

    describe("Running scenarios", async function () {
        it("Upgrade vault", async function () {
            const marketsBeforeUpgrade = await prevVaultState.methods
                .getMarkets({ answerId: 0 })
                .call()
                .then(res => {
                    return res._markets.reduce((acc, [key, value]) => {
                        return {
                            ...acc,
                            [key]: value,
                        };
                    }, {} as Record<string, (typeof res)["_markets"][0][1]>);
                });
            const detailsBeforeUpgrade = await prevVaultState.methods.getDetails({ answerId: 0 }).call();
            const { traceTree } = await locklift.tracing.trace(
                prevVaultState.methods
                    .upgrade({
                        meta: {
                            nonce: 0,
                            call_id: 0,
                            send_gas_to: owner.address,
                        },
                        code: locklift.factory.getContractArtifacts("GravixVault").code,
                    })
                    .send({
                        from: owner.address,
                        amount: toNano(1),
                    }),
            );
            vault = locklift.factory.getDeployedContract("GravixVault", prevVaultState.address);
            const marketsAfterUpgrade = await vault.methods
                .getMarkets({ answerId: 0 })
                .call()
                .then(res => {
                    return res._markets.reduce((acc, [key, value]) => {
                        return {
                            ...acc,
                            [key]: value,
                        };
                    }, {} as Record<string, (typeof res)["_markets"][0][1]>);
                });
            const detailsAfterUpgrade = await vault.methods.getDetails({ answerId: 0 }).call();

            Object.entries(marketsBeforeUpgrade).forEach(([key, value]) => {
                const { priceSource: priceSourceBefore, ...valueBefore } = value;
                const { priceSource: priceSourceAfter, ...valueAfter } = marketsAfterUpgrade[key];

                expect(valueBefore).deep.eq(valueAfter);
                expect(Number(priceSourceBefore) - 1).eq(Number(priceSourceAfter));
            });

            expect(detailsBeforeUpgrade._owner.equals(detailsAfterUpgrade._managers.owner)).true;
            expect(detailsBeforeUpgrade._marketManager.equals(detailsAfterUpgrade._managers.marketManager)).true;
            expect(detailsBeforeUpgrade._manager.equals(detailsAfterUpgrade._managers.manager)).true;

            expect(detailsBeforeUpgrade._priceNode.equals(detailsAfterUpgrade._priceNode)).true;
            expect(detailsBeforeUpgrade._pricePubkey).eq(detailsAfterUpgrade._pricePubkey);
            expect(detailsBeforeUpgrade._usdt.equals(detailsAfterUpgrade._usdtToken.root)).true;
            expect(detailsBeforeUpgrade._usdtWallet.equals(detailsAfterUpgrade._usdtToken.wallet)).true;

            expect(detailsBeforeUpgrade._stgUsdt.equals(detailsAfterUpgrade._stgUsdtToken.root)).true;
            expect(detailsBeforeUpgrade._stgUsdtWallet.equals(detailsAfterUpgrade._stgUsdtToken.wallet)).true;

            expect(detailsBeforeUpgrade._treasury.equals(detailsAfterUpgrade._treasuries.treasury)).true;
            expect(detailsBeforeUpgrade._devFund.equals(detailsAfterUpgrade._treasuries.devFund)).true;
            expect(detailsBeforeUpgrade._projectFund.equals(detailsAfterUpgrade._treasuries.projectFund)).true;

            expect(detailsBeforeUpgrade._poolBalance).eq(detailsAfterUpgrade._poolAssets.balance);
            expect(detailsBeforeUpgrade._stgUsdtSupply).eq(detailsAfterUpgrade._poolAssets.stgUsdtSupply);
            expect(detailsBeforeUpgrade._targetPrice).eq(detailsAfterUpgrade._poolAssets.targetPrice);

            expect(detailsBeforeUpgrade._insuranceFund).eq(detailsAfterUpgrade._insuranceFunds.balance);
            expect(detailsBeforeUpgrade._insuranceFundLimit).eq(detailsAfterUpgrade._insuranceFunds.limit);
            expect(detailsBeforeUpgrade._liquidationThresholdRate).eq(detailsAfterUpgrade._liquidation.thresholdRate);
            expect(detailsBeforeUpgrade._liquidatorRewardShare).eq(detailsAfterUpgrade._liquidation.rewardShare);
        });

        it("Upgrade account", async function () {
            await vault.methods
                .updateGravixAccountCode({
                    meta: {
                        nonce: 0,
                        callId: 0,
                        sendGasTo: owner.address,
                    },
                    code: locklift.factory.getContractArtifacts("GravixAccount").code,
                })
                .send({
                    from: owner.address,
                    amount: toNano(1),
                });

            const { traceTree } = await locklift.tracing.trace(
                vault.methods
                    .upgradeGravixAccount({
                        meta: {
                            nonce: 0,
                            callId: 0,
                            sendGasTo: user.address,
                        },
                    })
                    .send({ from: user.address, amount: toNano(1) }),
            );
            await traceTree.beautyPrint();
        });
    });
});
