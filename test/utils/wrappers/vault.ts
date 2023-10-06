import { Address, Contract, getRandomNonce, toNano, zeroAddress } from "locklift";
import { GravixVaultAbi } from "../../../build/factorySource";
import { Account } from "locklift/everscale-client";
import { TokenWallet } from "./token_wallet";
import { GravixAccount } from "./vault_acc";
import { bn } from "../common";
import { BOUNCE_HANDLING_FEE, FEE_FOR_TOKEN_TRANSFER, GRAVIX_ACCOUNT_DEPLOY_VALUE } from "../constants";

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
    public address: Address;

    constructor(readonly contract: Contract<GravixVaultAbi>, readonly owner: Account, readonly limitBot: Address) {
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address, owner: Account, limitBot: Address) {
        const contract = await locklift.factory.getDeployedContract("GravixVault", addr);
        return new GravixVault(contract, owner, limitBot);
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
    async getOpenOrderBaseValue(triggersExists: boolean): Promise<{ market: string; limit: string }> {
        return (await Promise.all([
            this.contract.methods
                .getBaseOpenMarketOrderValue({ _triggersExists: triggersExists })
                .call()
                .then(res => ({ market: bn(res.value0).plus(FEE_FOR_TOKEN_TRANSFER).toString() })),
            this.contract.methods
                .getBaseOpenLimitOrderValue({ _triggersExists: triggersExists })
                .call()
                .then(res => ({ limit: bn(res.value0).plus(FEE_FOR_TOKEN_TRANSFER).toString() })),
        ]).then(res => res.reduce((acc, val) => ({ ...acc, ...val }), {}))) as { market: string; limit: string };
    }
    async getClosePositionValue() {
        return this.contract.methods
            .getMinValueForClosePosition()
            .call()
            .then(res => res.value0);
    }
    async getFullOpenOrderValue(triggersExists: boolean): Promise<{ market: string; limit: string }> {
        const { limit, market } = await this.getOpenOrderBaseValue(triggersExists);
        return {
            limit: bn(limit).plus(BOUNCE_HANDLING_FEE).plus(GRAVIX_ACCOUNT_DEPLOY_VALUE).toString(),
            market: bn(market).plus(BOUNCE_HANDLING_FEE).plus(GRAVIX_ACCOUNT_DEPLOY_VALUE).toString(),
        };
    }
    async getSetOrUpdateTriggersValue() {
        return this.contract.methods
            .getSetOrUpdateTriggersMinValue()
            .call()
            .then(res => res.value0);
    }
    async account(user: Account | Address) {
        return GravixAccount.from_addr(await this.getAccountAddress(user));
    }
    async getAccountAddress(user: Account | Address) {
        return this.contract.methods
            .getGravixAccountAddress({ user: (user as Account).address || user, answerId: 0 })
            .call()
            .then(res => res.value0);
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

    async setPriceNode(priceNode: Address) {
        return this.contract.methods
            .setPriceNode({
                newNode: priceNode,
                meta: { callId: 0, nonce: 0, sendGasTo: this.owner.address },
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
        stopLossTriggerPrice = 0,
        takeProfitTriggerPrice = 0,
        value: string = toNano(5),
    ) {
        const payload = (
            await this.contract.methods
                .encodeMarketOrder({
                    _marketIdx: marketIdx,
                    _positionType: positionType,
                    _leverage: leverage,
                    _expectedPrice: expectedPrice,
                    _maxSlippageRate: max_slippage,
                    _price: empty_price,
                    _callId: callId,
                    _referrer: referrer,
                    _stopLossTriggerPrice: stopLossTriggerPrice,
                    _takeProfitTriggerPrice: takeProfitTriggerPrice,
                    _nonce: 0,
                })
                .call()
        ).payload;
        return await from_wallet.transfer(amount, this.contract.address, payload, value);
    }

    async openLimitPosition({
        callId = 0,
        limitType,
        positionType,
        leverage,
        referrer = zeroAddress,
        marketIdx,
        triggerPrice,
        amount,
        fromWallet,
        stopLossTriggerPrice = 0,
        takeProfitTriggerPrice = 0,
        value = toNano(5),
    }: {
        fromWallet: TokenWallet;
        amount: number;
        marketIdx: number;
        positionType: 0 | 1; // 0 - short, 1 - long
        leverage: number;
        triggerPrice: number | string;
        referrer?: Address;
        limitType: 0 | 1; // 0 - limit, 1 - stop
        callId: number;
        stopLossTriggerPrice?: number;
        takeProfitTriggerPrice?: number;
        value?: string;
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
                    _stopLossTriggerPrice: stopLossTriggerPrice,
                    _takeProfitTriggerPrice: takeProfitTriggerPrice,
                })
                .call()
        ).payload;
        return await fromWallet.transfer(amount, this.contract.address, payload, value);
    }

    async addCollateral(
        fromWallet: TokenWallet,
        user: Account,
        amount: number,
        positionKey: number,
        marketIdx: number | string,
        callId = 0,
        value = toNano(2.1),
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

        return fromWallet.transfer(amount, this.contract.address, payload, value);
    }

    async removeCollateral(
        user: Account,
        amount: number,
        positionKey: number,
        marketIdx: number | string,
        callId = 0,
        value = toNano(2.1),
    ) {
        return await this.contract.methods
            .removeCollateral({
                marketIdx: marketIdx,
                positionKey: positionKey,
                amount: amount,
                meta: { callId: callId, nonce: 0, sendGasTo: user.address },
            })
            .send({ from: user.address, amount: toNano(2.1) });
    }

    async closePosition(
        user: Account,
        positionKey: number,
        marketIdx: number | string,
        callId = 0,
        value = toNano(2.1),
    ) {
        return await this.contract.methods
            .closePosition({
                positionKey: positionKey,
                marketIdx: marketIdx,
                price: empty_price,
                meta: { callId: callId, nonce: 0, sendGasTo: user.address },
            })
            .send({ from: user.address, amount: value });
    }

    async executeTriggers({
        callId = 0,
        stopPositionsConfig,
    }: {
        callId?: number;
        stopPositionsConfig: Parameters<
            Contract<GravixVaultAbi>["methods"]["executePositionsTriggers"]
        >[0]["positionsMap"];
    }) {
        return this.contract.methods
            .executePositionsTriggers({
                meta: {
                    sendGasTo: this.limitBot,
                    callId: callId,
                    nonce: getRandomNonce(),
                },
                positionsMap: stopPositionsConfig,
            })
            .send({
                from: this.limitBot,
                amount: toNano(5),
            });
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
