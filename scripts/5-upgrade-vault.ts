import { toNano } from "locklift";
import { isValidEverAddress } from "../test/utils/common";
import { GravixVaultAbi } from "../build/factorySource";

const prompts = require("prompts");
const ora = require("ora");

const main = async () => {
    await locklift.deployments.load();

    console.log("\x1b[1m", "\n\nUpgrade vault:");
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
    const vault_artifacts = await locklift.factory.getContractArtifacts("GravixVault");

    const spinner = ora("Upgrading vault...").start();

    await locklift.tracing.trace(
        vault.methods
            .upgrade({
                code: vault_artifacts.code,
                meta: { sendGasTo: manager.address, callId: 0, nonce: 0 },
            })
            .send({ from: manager.address, amount: toNano(1) }),
    );

    spinner.succeed(`Vault upgraded`);
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
