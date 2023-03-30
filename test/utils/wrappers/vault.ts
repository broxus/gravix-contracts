import {Address, Contract, toNano} from "locklift";
import {GravixVaultAbi} from "../../../build/factorySource";
import {Account} from 'locklift/everscale-client'
import {TokenWallet} from "./token_wallet";
import {GravixAccount} from "./vault_acc";

const logger = require("mocha-logger");


export interface MarketConfig {
    priceSource: 0 | 1 | 2,
    maxLongsUSD: number,
    maxShortsUSD: number,
    noiWeight: number,
    maxLeverage: number,
    depthAsset: number,
    fees: {
        openFeeRate: number,
        closeFeeRate: number,
        baseSpreadRate: number,
        baseDynamicSpreadRate: number,
        borrowBaseRatePerHour: number,
        fundingBaseRatePerHour: number
    },
    scheduleEnabled: boolean,
    workingHours: Array<any>
}

export interface Oracle {
    dex: {
        targetToken: Address,
        path: {addr: Address, leftRoot: Address, rightRoot: Address}[]
    },
    chainlink: {
        ticker: string,
        chainID: number,
        ttl: number
    },
    priceNode: {
        ticker: string,
        maxOracleDelay: number;
        maxServerDelay: number;
    }
}

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
        const contract = await locklift.factory.getDeployedContract('GravixVault', addr);
        return new GravixVault(contract, owner);
    }

    async getEvents(event_name: string) {
        // @ts-ignore
        return (await this.contract.getPastEvents({filter: (event) => event.event === event_name})).events;
    }

    async getEvent(event_name: string) {
        const last_event = (await this.getEvents(event_name)).shift();
        if (last_event) {
            return last_event.data;
        }
        return null;
    }

    async account(user: Account) {
        const address = await this.contract.methods.getGravixAccountAddress({user: user.address, answerId: 0}).call();
        return GravixAccount.from_addr(address.value0);
    }

    async addMarkets(markets: MarketConfig[], call_id=0) {
        return (await this.contract.methods.addMarkets({
            new_markets: markets,
            meta: {call_id: call_id, nonce: 0, send_gas_to: this.owner.address}
        }).send({
            from: this.owner.address,
            amount: toNano(2)
        }));
    }

    async setOracles(oracles: [number, Oracle][], call_id=0) {
        return this.contract.methods.setOracleConfigs({
            new_oracles: oracles, meta: {call_id: call_id, nonce: 0, send_gas_to: this.owner.address}
        }).send({
            from: this.owner.address,
            amount: toNano(2)
        });
    }

    async addLiquidity(from_wallet: TokenWallet, amount: number, call_id=0) {
        const payload = (await this.contract.methods.encodeLiquidityDeposit({nonce: 0, call_id: call_id}).call()).payload;
        return await from_wallet.transfer(amount, this.contract.address, payload, toNano(5));
    }

    async details() {
        return await this.contract.methods.getDetails({answerId: 0}).call();
    }

    async deployGravixAccount(user: Account, call_id=0) {
        return await this.contract.methods.deployGravixAccount(
            {user: user.address, answerId: 0, meta: {call_id: call_id, nonce: 0, send_gas_to: user.address}}
        ).send({from: user.address, amount: toNano(1)})
    }

    async getDynamicSpread(market_idx: number, position_size_asset: number, position_type: 0 | 1) {
        return (await this.contract.methods.getDynamicSpread({
            market_idx: market_idx, position_size_asset: position_size_asset, position_type: position_type, answerId: 0
        }).call()).dynamic_spread;
    }

    async openPosition(
        from_wallet: TokenWallet,
        amount: number,
        market_idx: number,
        position_type: 0 | 1, // 0 - short, 1 - long
        leverage: number,
        expected_price: number | string,
        max_slippage: number,
        call_id=0
    ) {
        const payload = (await this.contract.methods.encodeMarketOrder({
            market_idx: market_idx,
            position_type: position_type,
            leverage: leverage,
            expected_price: expected_price,
            max_slippage_rate: max_slippage,
            event_data: empty_event,
            price: empty_price,
            call_id: call_id,
            nonce: 0
        }).call()).payload;
        return await from_wallet.transfer(amount, this.contract.address, payload, toNano(2.1));
    }

    async addCollateral(
      from_wallet: TokenWallet,
      user: Account,
      amount: number,
      position_key: number,
      market_idx: number | string,
      call_id=0
    ) {
        const payload = (await this.contract.methods.encodeAddCollateral({
            market_idx: market_idx,
            position_key: position_key,
            call_id: call_id,
            nonce: 0
        }).call()).payload;

        return from_wallet.transfer(amount, this.contract.address, payload, toNano(2.1));
    }

    async removeCollateral(
      user: Account,
      amount: number,
      position_key: number,
      market_idx: number | string,
      call_id=0
    ) {
        return await this.contract.methods.removeCollateral({
            market_idx: market_idx,
            position_key: position_key,
            amount: amount,
            meta: {call_id: call_id, nonce: 0, send_gas_to: user.address}
        }).send({from: user.address, amount: toNano(2.1)});
    }

    async closePosition(
        user: Account,
        position_key: number,
        market_idx: number | string,
        call_id=0
    ) {
        return await this.contract.methods.closePosition(
            {
                position_key: position_key,
                market_idx: market_idx,
                event_data: empty_event,
                price: empty_price,
                meta: {call_id: call_id, nonce: 0, send_gas_to: user.address}}
        ).send({from: user.address, amount: toNano(2.1)});
    }

    async liquidatePositions(
      liquidations: [
        number,
          {
              eventData: { eventTransaction: number; eventData: string; eventBlockNumber: number; eventIndex: number; eventBlock: number };
              price: {price: number, serverTime: number, oracleTime: number, ticker: string, signature: string},
              positions: Array<{ user: Address; positionKey: number }>
          }
      ][],
      call_id=0
    ) {
        return await this.contract.methods.liquidatePositions({
            liquidations: liquidations,
            meta: {call_id: call_id, nonce: 0, send_gas_to: this.owner.address}
        }).send({from: this.owner.address, amount: toNano(10)});
    }
}
