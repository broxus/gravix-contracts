import {Address, Contract} from "locklift";
import {GravixAccountAbi} from "../../../build/factorySource";
import {Account} from 'locklift/everscale-client'

const logger = require("mocha-logger");

export class GravixAccount {
    public contract: Contract<GravixAccountAbi>;
    public address: Address;

    constructor(token_contract: Contract<GravixAccountAbi>) {
        this.contract = token_contract;
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address) {
        const contract = await locklift.factory.getDeployedContract('GravixAccount', addr);
        return new GravixAccount(contract);
    }

    async positions() {
        return (await this.contract.methods.positions().call()).positions;
    }
}