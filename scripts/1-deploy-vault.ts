import { toNano } from "locklift";
import { deployUser, setupVault } from "../test/utils/common";
import { readFileSync } from "fs";

const { isValidEverAddress } = require("../test/utils/common");
const fs = require("fs");
const prompts = require("prompts");
const ora = require("ora");

const main = async () => {
    console.log("\x1b[1m", "\n\nDeploy Gravix Vault:");
    const response = await prompts([
        {
            type: "text",
            name: "_owner",
            message: "Gravix Vault owner address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_usdt",
            message: "USDT root address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_stg_usdt",
            message: "stgUSDT root address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_oracle",
            message: "Oracle contract address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_priceNode",
            message: "Price node contract address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
        {
            type: "text",
            name: "_pricePubkey",
            message: "Oracle service pubkey",
        }
    ]);
    console.log("\x1b[1m", "\nSetup complete! ✔");

    const spinner = ora("Deploying temporary owner...").start();
    const user = await deployUser(10, false);
    spinner.succeed(`Tmp owner deployed: ${user.address}`);

    spinner.start("Deploying vault...");
    const vault = await setupVault({
        owner: user,
        usdt: response._usdt,
        stg_usdt: response._stg_usdt,
        priceNode: response._priceNode,
        pricePk: `0x${response._pricePubkey}`,
        limitBot: user.address,
        log: false
      });
    spinner.succeed(`Gravix Vault deployed: ${vault.address}`);

    const market_configs = JSON.parse(readFileSync("./setup.json").toString());
    const oracle_configs = JSON.parse(readFileSync("./oracle_setup.json").toString());

    spinner.start(`Adding markets...`);
    await locklift.tracing.trace(vault.addMarkets(market_configs));
    spinner.succeed(`Markets added`);

    spinner.start(`Setting up market oracles config...`);
    await locklift.tracing.trace(vault.setOracles(oracle_configs.map((conf: any, idx: any) => [idx, conf])));
    spinner.succeed("Oracles set up");

    spinner.start(`Transferring ownership...`);
    await vault.contract.methods
        .transferOwnership({ newOwner: response._owner, meta: { callId: 0, sendGasTo: response._owner, nonce: 0 } })
        .send({ from: user.address, amount: toNano(2) });
    spinner.succeed("Ownership transferred");

    console.log("Dont forget to transfer stgUSDT ownership!");
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
