import { getRandomNonce, toNano } from "locklift";
import { deployUser, isValidEverAddress } from "../test/utils/common";
import { readFileSync } from "fs";

const prompts = require("prompts");
const ora = require("ora");

const main = async () => {
  console.log("\x1b[1m", "\n\nDeploy Limit vault:");
  const response = await prompts([
    {
      type: "text",
      name: "_owner",
      message: "Price node owner address",
      validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
    },
    {
      type: "text",
      name: "_gravixVault",
      message: "Gravix Vault",
      validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
    }
  ]);
  console.log("\x1b[1m", "\nSetup complete! ✔");

  const signer = await locklift.keystore.getSigner("0");

  let spinner = ora("Deploying limit bot vault...").start();
  const { contract } = await locklift.tracing.trace(
    locklift.factory.deployContract({
      contract: "LimitBotVault",
      initParams: { nonce: getRandomNonce() },
      constructorParams: {
        _owner: response._owner,
        _gravixVault: response._gravixVault
      },
      publicKey: signer?.publicKey as string,
      value: toNano(5),
    }),
  );
  spinner.succeed(`Limit vault: ${contract.address}`);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
