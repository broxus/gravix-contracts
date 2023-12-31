import { Address, toNano } from "locklift";
import { isValidEverAddress } from "../test/utils/common";
import { readFileSync } from "fs";
import { GravixVaultAbi } from "../build/factorySource";

const prompts = require("prompts");
const ora = require("ora");

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
    // get users list from simple txt file, where each line is an address
    let users = readFileSync("./users.txt").toString().trim().split("\n");

    const spinner = ora("Upgrading accounts...").start();
    while (users.length) {
        const pack = users.splice(0, 500).map(i => new Address(i));
        await locklift.tracing.trace(
            vault.methods
                .forceUpgradeGravixAccountsByUsers({
                    users: pack,
                    meta: { callId: 0, nonce: 0, sendGasTo: manager.address },
                })
                .send({ from: manager.address, amount: toNano(pack.length + 2) }),
        );
        console.log(`Upgraded ${pack.length} accounts`);
    }
    spinner.succeed(`All accounts upgraded`);
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
