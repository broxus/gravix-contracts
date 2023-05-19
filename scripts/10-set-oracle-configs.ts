import {toNano} from "locklift";
import {deployUser, setupVault} from "../test/utils/common";
import {readFileSync} from "fs";
import {GravixVaultAbi} from "../build/factorySource";
import {GravixVault} from "../test/utils/wrappers/vault";

const {isValidEverAddress} = require('../test/utils/common');
const fs = require('fs');
const prompts = require('prompts');
const ora = require('ora');



const main = async () => {
  await locklift.deployments.load();

  const oracle_configs = JSON.parse(readFileSync('./oracle_setup.json').toString());
  const spinner = ora('Setting up market oracles config...').start();

  const manager = await locklift.deployments.getAccount('Manager').account;
  console.log('\x1b[1m', `\nGet manager from deployments: ${manager.address}`);

  const vault_raw = await locklift.deployments.getContract<GravixVaultAbi>('Vault');
  const vault = new GravixVault(vault_raw, manager);
  console.log(`Get vault from deployments: ${vault.address}`);

  await locklift.tracing.trace(vault.setOracles(
      oracle_configs.map((conf: any, idx: any) => [idx, conf])
    )
  );
  spinner.succeed('Oracles set up');

};
main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
