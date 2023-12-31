import { Address, Contract, toNano } from "locklift";
import { FactorySource } from "../../../build/factorySource";
import { Account } from "locklift/everscale-client";
import { runTargets } from "../common";

export class TokenWallet {
    public contract: Contract<FactorySource["TokenWalletUpgradeable"]>;
    public _owner: Account | null;
    public address: Address;
    public name: string | undefined;

    constructor(wallet_contract: Contract<FactorySource["TokenWalletUpgradeable"]>, wallet_owner: Account | null) {
        this.contract = wallet_contract;
        this._owner = wallet_owner;
        this.address = this.contract.address;
    }

    static async from_addr(addr: Address, owner: Account | null) {
        const wallet = await locklift.factory.getDeployedContract("TokenWalletUpgradeable", addr);
        return new TokenWallet(wallet, owner);
    }

    async owner() {
        return await this.contract.methods.owner({ answerId: 0 }).call();
    }

    async root() {
        return await this.contract.methods.root({ answerId: 0 }).call();
    }

    async balance() {
        return (await this.contract.methods.balance({ answerId: 0 }).call()).value0;
    }

    async transfer(amount: number, receiver: Address, payload = "", value: any) {
        let notify = payload !== "";

        const owner = this._owner as Account;
        return await this.contract.methods
            .transfer({
                amount: amount,
                recipient: receiver,
                deployWalletValue: 0,
                remainingGasTo: owner.address,
                notify: notify,
                payload: payload,
            })
            .send({
                amount: value || toNano(5),
                from: owner.address,
            });
    }

    async multiTransfer(amounts: number[], receiver: Address, payload = "", value: any) {
        let notify = payload !== "";

        const owner = this._owner as Account;
        return runTargets(
            owner,
            Array.from({ length: amounts.length }, () => this.contract),
            Array.from({ length: amounts.length }, () => "transfer"),
            Array.from({ length: amounts.length }, (_, i) => {
                return {
                    amount: amounts[i],
                    recipient: receiver,
                    deployWalletValue: 0,
                    remainingGasTo: owner.address,
                    notify: notify,
                    payload: payload,
                };
            }),
            Array.from({ length: amounts.length }, () => value),
        );
    }
}
