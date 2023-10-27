import { Account } from "locklift/everscale-client";
import { Token } from "./utils/wrappers/token";
import { Address, Contract, lockliftChai, toNano } from "locklift";
import chai, { expect } from "chai";
import {
    GravixAccountAbi,
    GravixAccountPrevVersionAbi,
    GravixVaultAbi,
    GravixVaultPrevVersionAbi,
} from "../build/factorySource";

const logger = require("mocha-logger");
chai.use(lockliftChai);

describe("Testing main orders flow", async function () {
    let owner: Account;
    let user: Account;

    let vault: Contract<GravixVaultAbi>;
    let prevVaultContractState: Contract<GravixVaultPrevVersionAbi>;
    let prevAccountContractState: Contract<GravixAccountPrevVersionAbi>;
    let account: Contract<GravixAccountAbi>;

    const MARKET_IDX = 0;
    describe("Setup contracts", async function () {
        it("Run fixtures", async function () {
            // await locklift.deployments.fixture();

            prevVaultContractState = locklift.factory.getDeployedContract(
                "GravixVaultPrevVersion",
                new Address("0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113"),
            );
            const prevVaultDetails = await prevVaultContractState.methods.getDetails({ answerId: 0 }).call();
            prevAccountContractState = locklift.factory.getDeployedContract(
                "GravixAccountPrevVersion",
                new Address("0:0b8f78c747010b6fe7f164c84614808ee6ca0d55b55644726225be758f1e6641"),
            );
            const prevAccountDetails = await prevAccountContractState.methods.getDetails({ answerId: 0 }).call();
            owner = locklift.network.insertWallet(prevVaultDetails._owner);
            user = locklift.network.insertWallet(prevAccountDetails._user);
        });
    });

    describe("Running scenarios", async function () {
        it("Upgrade vault", async function () {
            const marketsBeforeUpgrade = await prevVaultContractState.methods
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
            const detailsBeforeUpgrade = await prevVaultContractState.methods.getDetails({ answerId: 0 }).call();
            const { traceTree } = await locklift.tracing.trace(
                prevVaultContractState.methods
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
            vault = locklift.factory.getDeployedContract("GravixVault", prevVaultContractState.address);
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
                const { priceSource: priceSourceBefore, lastNoiUpdatePrice, noiWeight, ...valueBefore } = value;
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
            const positionsBefore = await prevAccountContractState.methods
                .positions()
                .call()
                .then(res =>
                    res.positions.reduce((acc, [key, value]) => {
                        return {
                            ...acc,
                            [key]: value,
                        };
                    }, {} as Record<string, (typeof res)["positions"][0][1]>),
                );
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
            account = locklift.factory.getDeployedContract("GravixAccount", prevAccountContractState.address);
            const positionsAfter = await account.methods
                .positions()
                .call()
                .then(res =>
                    res.positions.reduce((acc, [key, value]) => {
                        return {
                            ...acc,
                            [key]: value,
                        };
                    }, {} as Record<string, (typeof res)["positions"][0][1]>),
                );

            Object.entries(positionsBefore).forEach(([key, value]) => {
                const { ...positionBefore } = value;
                const { stopLoss, takeProfit, ...positionAfter } = positionsAfter[key];
                expect(positionBefore).deep.eq(positionAfter);
                expect(stopLoss).to.be.eq(null);
                expect(takeProfit).to.be.eq(null);
            });
        });
    });
});
