import {Address, Contract, toNano} from "locklift";
import {FactorySource} from "../../../build/factorySource";
import {Account} from 'locklift/everscale-client'

const logger = require("mocha-logger");


interface MarketConfig {
    priceSource: number,
    maxLongs: number,
    maxShorts: number,
    noiWeight: number,
    maxLeverage: number,
    depth: number,
    fees: {
        openFeeRate: number,
        closeFeeRate: number,
        baseSpreadRate: number,
        baseDynamicSpreadRate: number,
        borrowBaseRatePerHour: number,
        fundingBaseRatePerHour: number
    },
    scheduleEnabled: boolean,
    workingHours: any
}


export class GravixVault {
    public contract: Contract<FactorySource["GravixVault"]>;
    public owner: Account;
    public address: Address;

    constructor(token_contract: Contract<FactorySource["GravixVault"]>, owner: Account) {
        this.contract = token_contract;
        this.owner = owner;
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address, owner: Account) {
        const contract = await locklift.factory.getDeployedContract('GravixVault', addr);
        return new GravixVault(contract, owner);
    }

    async addMarkets(markets: MarketConfig[], call_id=0) {
        return (await this.contract.methods.addMarkets({
            new_markets: markets,
            meta: {call_id: call_id, nonce: 0, send_gas_to: this.owner.address}
        }).send({
            from: this.owner.address,
            amount: toNano(markets.length)
        }));
    }
}
