import {Address, Contract, toNano} from "locklift";
import {GravixVaultAbi} from "../build/factorySource";
import {getAccountsByCodeHash, isValidEverAddress, sleep} from "../test/utils/common";

const prompts = require("prompts");
const ora = require("ora");

const cur_code_hash = "f413970f94e7c196f431447e92f2189f2448498b924400b14eef9d6eddbf15b8";
let fetching = true;

// @dev Async function that iterates over an array of addresses in a while loop in batches of 20
// and calls the forceUpgradeGravixAccountsByContracts method on the vault contract
// This function is not really reliable as it does not wait for the transaction to be really executed
// But it is much faster than synchronous version
const upgradeAccounts = async (vault: Contract<GravixVaultAbi>, old_accs: Address[], manager: Address) => {
    console.log('Starting upgrade loop in parallel', old_accs.length);
    while (fetching || old_accs.length) {
        const pack = old_accs.splice(0, 500);
        await vault.methods
                .forceUpgradeGravixAccountsByContracts({
                    contracts: pack,
                    meta: { callId: 0, nonce: 0, sendGasTo: manager },
                })
                .send({ from: manager, amount: toNano(pack.length + 2) });
        console.log("\x1b[1m", `${old_accs.length} accounts remain to upgrade`);
        await sleep(1000);
    }
    console.log('Finished upgrade loop')
}

const main = async () => {
    await locklift.deployments.load();

    console.log("\x1b[1m", "\n\nUpgrade vault accounts:");
    const response = await prompts([
        {
            type: "select",
            name: "vault",
            message: "Select vault to upgrade",
            choices: [
                { title: "prod", value: "prod_Vault" },
                { title: "beta", value: "beta_Vault" },
            ],
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
    ]);
    const manager = await locklift.deployments.getAccount("Manager").account;
    console.log("\x1b[1m", `\nGet manager from deployments: ${manager.address}`);

    const vault = await locklift.deployments.getContract<GravixVaultAbi>(response.vault);
    console.log(`Get vault from deployments: ${vault.address}`);

    console.log("Fetching old accounts...");
    let old_accs: Address[] = [];
    let continuation: string | undefined; // just not undefined
    setTimeout(upgradeAccounts, 5000, vault, old_accs, manager.address);
    setInterval(() => console.log('Collect progress (not upgraded):', old_accs.length), 5000);
    while (true) {
        const accs = await getAccountsByCodeHash(cur_code_hash, continuation);
        accs.accounts.map((acc) => old_accs.push(acc));
        continuation = accs.continuation;
        if (!continuation) break;
    }
    fetching = false;
    while (old_accs.length) {
        await sleep(5000);
    }
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
