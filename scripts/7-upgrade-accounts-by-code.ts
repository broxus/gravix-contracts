import { Address, toNano } from "locklift";
import { GravixVaultAbi } from "../build/factorySource";
import {getAccountsByCodeHash, isValidEverAddress} from "../test/utils/common";

const prompts = require("prompts");
const ora = require("ora");

// f413970f94e7c196f431447e92f2189f2448498b924400b14eef9d6eddbf15b8 - before limits
// e35c25eed033cb19e9b7a029471cdaa2ff653d4362e6d081b2b02e3c863ec4af - limits
// 2f9b3e60a0872ea38a0e205f39e4003799e866629276510dc2a39864dfb28031 - 2.1
const cur_code_hash = "e35c25eed033cb19e9b7a029471cdaa2ff653d4362e6d081b2b02e3c863ec4af";

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
    const spinner = ora("Fetching old accounts...").start();

    let old_accs: Address[] = [];
    let continuation: string | undefined; // just not undefined
    while (true) {
        const accs = await getAccountsByCodeHash(cur_code_hash, continuation);
        old_accs = old_accs.concat(accs.accounts);
        continuation = accs.continuation;
        if (old_accs.length % 500 === 0) console.log('Collect progress:', old_accs.length);
        if (!continuation) break;
    }
    spinner.succeed(`Found ${old_accs.length} old accounts`);

    spinner.start("Upgrading accounts...");
    while (old_accs.length) {
        const pack = old_accs.splice(0, 500);
        await locklift.transactions.waitFinalized(
            vault.methods
                .forceUpgradeGravixAccountsByContracts({
                    contracts: pack,
                    meta: { callId: 0, nonce: 0, sendGasTo: manager.address },
                })
                .send({ from: manager.address, amount: toNano(pack.length + 2) }),
        );
        console.log("\x1b[1m", `Upgraded ${pack.length} accounts`);
    }
    spinner.succeed(`All accounts upgraded`);
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
