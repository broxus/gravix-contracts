import { Address, Contract, getRandomNonce, toNano, zeroAddress } from "locklift";
import { GravixVaultAbi } from "../../../build/factorySource";
import { Account } from "locklift/everscale-client";
import { TokenWallet } from "./token_wallet";
import { GravixAccount } from "./vault_acc";

const logger = require("mocha-logger");

export interface MarketConfig {
    priceSource: 0 | 1 | 2;
    maxLongsUSD: number;
    maxShortsUSD: number;
    noiWeight: number;
    maxLeverage: number;
    depthAsset: number;
    fees: {
        openFeeRate: number;
        closeFeeRate: number;
        baseSpreadRate: number;
        baseDynamicSpreadRate: number;
        borrowBaseRatePerHour: number;
        fundingBaseRatePerHour: number;
    };
    scheduleEnabled: boolean;
    workingHours: Array<any>;
}

export interface Oracle {
    dex: {
        targetToken: Address;
        path: { addr: Address; leftRoot: Address; rightRoot: Address }[];
    };
    priceNode: {
        ticker: string;
        maxOracleDelay: number;
        maxServerDelay: number;
    };
}

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

export class GravixVault {
    public contract: Contract<GravixVaultAbi>;
    public owner: Account;
    public address: Address;

    constructor(contract: Contract<GravixVaultAbi>, owner: Account) {
        this.contract = contract;
        this.owner = owner;
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address, owner: Account) {
        const contract = await locklift.factory.getDeployedContract("GravixVault", addr);
        return new GravixVault(contract, owner);
    }

    async getEvents(event_name: string) {
        // @ts-ignore
        return (await this.contract.getPastEvents({ filter: event => event.event === event_name })).events;
    }

    async getEvent(event_name: string) {
        const last_event = (await this.getEvents(event_name)).shift();
        if (last_event) {
            return last_event.data;
        }
        return null;
    }

    async account(user: Account) {
        const address = await this.contract.methods.getGravixAccountAddress({ user: user.address, answerId: 0 }).call();
        return GravixAccount.from_addr(address.value0);
    }

    async addMarkets(markets: MarketConfig[], callId = 0) {
        return await this.contract.methods
            .addMarkets({
                newMarkets: markets,
                meta: { callId: callId, nonce: 0, sendGasTo: this.owner.address },
            })
            .send({
                from: this.owner.address,
                amount: toNano(2),
            });
    }

    async setOracles(oracles: [number, Oracle][], callId = 0) {
        return this.contract.methods
            .setOracleConfigs({
                newOracles: oracles,
                meta: { callId: callId, nonce: 0, sendGasTo: this.owner.address },
            })
            .send({
                from: this.owner.address,
                amount: toNano(2),
            });
    }

    async addLiquidity(from_wallet: TokenWallet, amount: number, callId = 0) {
        const payload = (await this.contract.methods.encodeLiquidityDeposit({ nonce: 0, callId: callId }).call())
            .payload;
        return await from_wallet.transfer(amount, this.contract.address, payload, toNano(5));
    }

    async details() {
        return await this.contract.methods.getDetails({ answerId: 0 }).call();
    }

    async deployGravixAccount(user: Account, referrer = zeroAddress, callId = 0) {
        return await this.contract.methods
            .deployGravixAccount({
                answerId: 0,
                referrer: referrer,
                meta: { callId: callId, nonce: 0, sendGasTo: user.address },
            })
            .send({ from: user.address, amount: toNano(1) });
    }

    async setNewAccountCode(code?: string) {
        return this.contract.methods
            .updateGravixAccountCode({
                code: code || locklift.factory.getContractArtifacts("GravixAccount").code,
                meta: {
                    callId: getRandomNonce(),
                    sendGasTo: this.owner.address,
                    nonce: 0,
                },
            })
            .send({
                from: this.owner.address,
                amount: toNano(2),
            });
    }

    async getDynamicSpread(marketIdx: number, positionSizeAsset: number, positionType: 0 | 1) {
        return (
            await this.contract.methods
                .getDynamicSpread({
                    marketIdx: marketIdx,
                    positionSizeAsset: positionSizeAsset,
                    positionType: positionType,
                    answerId: 0,
                })
                .call()
        ).dynamicSpread;
    }

    async openMarketPosition(
        from_wallet: TokenWallet,
        amount: number,
        marketIdx: number,
        positionType: 0 | 1, // 0 - short, 1 - long
        leverage: number,
        expectedPrice: number | string,
        max_slippage: number,
        referrer: Address,
        callId = 0,
    ) {
        const payload = (
            await this.contract.methods
                .encodeMarketOrder({
                    marketIdx: marketIdx,
                    positionType: positionType,
                    leverage: leverage,
                    expectedPrice: expectedPrice,
                    maxSlippageRate: max_slippage,
                    price: empty_price,
                    callId: callId,
                    referrer: referrer,
                    nonce: 0,
                })
                .call()
        ).payload;
        return await from_wallet.transfer(amount, this.contract.address, payload, toNano(5));
    }

    async openLimitPosition({
        callId = 0,
        limitType,
        positionType,
        leverage,
        referrer,
        marketIdx,
        triggerPrice,
        amount,
        fromWallet,
    }: {
        fromWallet: TokenWallet;
        amount: number;
        marketIdx: number;
        positionType: 0 | 1; // 0 - short, 1 - long
        leverage: number;
        triggerPrice: number | string;
        referrer: Address;
        limitType: 0 | 1; // 0 - limit, 1 - stop
        callId: number;
    }) {
        const payload = (
            await this.contract.methods
                .encodeLimitOrder({
                    _marketIdx: marketIdx,
                    _positionType: positionType,
                    _leverage: leverage,
                    _triggerPrice: triggerPrice,
                    _price: empty_price,
                    _callId: callId,
                    _referrer: referrer,
                    _nonce: 0,
                    _limitOrderType: limitType,
                })
                .call()
        ).payload;
        return await fromWallet.transfer(amount, this.contract.address, payload, toNano(3.6));
    }

    async addCollateral(
        fromWallet: TokenWallet,
        user: Account,
        amount: number,
        positionKey: number,
        marketIdx: number | string,
        callId = 0,
    ) {
        const payload = (
            await this.contract.methods
                .encodeAddCollateral({
                    marketIdx: marketIdx,
                    positionKey: positionKey,
                    callId: callId,
                    nonce: 0,
                })
                .call()
        ).payload;

        return fromWallet.transfer(amount, this.contract.address, payload, toNano(2.1));
    }

    async removeCollateral(user: Account, amount: number, positionKey: number, marketIdx: number | string, callId = 0) {
        return await this.contract.methods
            .removeCollateral({
                marketIdx: marketIdx,
                positionKey: positionKey,
                amount: amount,
                meta: { callId: callId, nonce: 0, sendGasTo: user.address },
            })
            .send({ from: user.address, amount: toNano(2.1) });
    }

    async closePosition(user: Account, positionKey: number, marketIdx: number | string, callId = 0) {
        return await this.contract.methods
            .closePosition({
                positionKey: positionKey,
                marketIdx: marketIdx,
                price: empty_price,
                meta: { callId: callId, nonce: 0, sendGasTo: user.address },
            })
            .send({ from: user.address, amount: toNano(2.1) });
    }

    async liquidatePositions(
        liquidations: [
            number,
            {
                price: { price: number; serverTime: number; oracleTime: number; ticker: string; signature: string };
                positions: Array<{ user: Address; positionKey: number }>;
            },
        ][],
        callId = 0,
    ) {
        return await this.contract.methods
            .liquidatePositions({
                liquidations: liquidations,
                meta: { callId: callId, nonce: 0, sendGasTo: this.owner.address },
            })
            .send({
                from: this.owner.address,
                amount: toNano(3 + liquidations.flatMap(([, { positions }]) => positions).length * 1.05),
            });
    }
}
