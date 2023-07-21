import { Address, Contract } from "locklift";
import { GravixAccountAbi } from "../../../build/factorySource";
import { Account } from "locklift/everscale-client";

const logger = require("mocha-logger");

export class GravixAccount {
    public contract: Contract<GravixAccountAbi>;
    public address: Address;

    constructor(token_contract: Contract<GravixAccountAbi>) {
        this.contract = token_contract;
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address) {
        const contract = await locklift.factory.getDeployedContract("GravixAccount", addr);
        return new GravixAccount(contract);
    }

    async positions() {
        return (await this.contract.methods.positions().call()).positions;
    }
    async getDetails() {
        return this.contract.methods.getDetails({ answerId: 0 }).call();
    }
    async getVersion() {
        return this.getDetails().then(res => res._currentVersion);
    }
    async getPositionView(
        positionKey: number,
        assetPrice: number | string,
        funding: { accShortUSDFundingPerShare: number; accLongUSDFundingPerShare: number },
    ) {
        return await this.contract.methods
            .getPositionView({
                input: {
                    positionKey: positionKey,
                    assetPrice: assetPrice,
                    funding: {
                        accShortUSDFundingPerShare: funding.accShortUSDFundingPerShare,
                        accLongUSDFundingPerShare: funding.accLongUSDFundingPerShare,
                    },
                },
                answerId: 0,
            })
            .call();
    }
}
