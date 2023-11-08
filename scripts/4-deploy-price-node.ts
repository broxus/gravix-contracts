import { getRandomNonce, toNano } from "locklift";
import { deployUser, isValidEverAddress } from "../test/utils/common";
import { readFileSync } from "fs";

const prompts = require("prompts");
const ora = require("ora");

const main = async () => {
    console.log("\x1b[1m", "\n\nDeploy Price node:");
    const response = await prompts([
        {
            type: "text",
            name: "_owner",
            message: "Price node owner address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_oraclePubkey",
            message: "Oracle pubkey",
        },
        {
            type: "text",
            name: "_daemonPubkey",
            message: "Daemon pubkey",
        },
    ]);
    console.log("\x1b[1m", "\nSetup complete! ✔");

    const price_node_configs = JSON.parse(readFileSync("./configs/price_node_configs.json").toString());

    const spinner = ora("Deploying temporary owner...").start();
    const user = await deployUser(3, false);
    spinner.succeed(`Tmp owner deployed: ${user.address}`);

    const signer = await locklift.keystore.getSigner("0");

    spinner.start("Deploying price node...");
    const { contract } = await locklift.tracing.trace(
        locklift.factory.deployContract({
            contract: "PriceNode",
            initParams: { deployNonce: getRandomNonce() },
            constructorParams: {
                _owner: user.address,
                _daemonPubkey: `0x${response._daemonPubkey}`,
                _oraclePubkey: `0x${response._oraclePubkey}`,
            },
            publicKey: signer?.publicKey as string,
            value: toNano(5),
        }),
    );
    spinner.succeed(`Price node: ${contract.address}`);

    spinner.start("Set configs...");
    await locklift.tracing.trace(
        contract.methods
            .setTickerConfigs({
                configs: price_node_configs,
            })
            .send({ from: user.address, amount: toNano(1) }),
    );
    spinner.succeed("Configs set");

    spinner.start("Transferring ownership...");
    await locklift.tracing.trace(
        contract.methods
            .transferOwnership({
                newOwner: response._owner,
            })
            .send({ from: user.address, amount: toNano(1) }),
    );
    spinner.succeed("Ownership transferred");
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
