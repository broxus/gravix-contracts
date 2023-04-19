import {Address, toNano} from "locklift";
import {isValidEverAddress} from "../test/utils/common";

const prompts = require('prompts');
const ora = require('ora');

const main = async () => {
  await locklift.deployments.load();
  console.log('\x1b[1m', '\n\nUpgrade vault account code:')
  const response = await prompts([
    {
      type: 'text',
      name: 'vault',
      message: 'Vault address',
      validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
    }
  ]);
  const vault = await locklift.factory.getDeployedContract('GravixVault', response.vault);

  const manager = await locklift.deployments.getAccount('Manager').account;
  console.log('\x1b[1m', `\nGet manager from deployments: ${manager.address}`);

  const spinner = ora('Install new account code...').start();

  const acc_artifacts = await locklift.factory.getContractArtifacts('GravixAccount');
  await locklift.tracing.trace(vault.methods.updateGravixAccountCode({
    code: acc_artifacts.code, meta: {send_gas_to: manager.address, call_id: 0, nonce: 0}
  }).send({from: manager.address, amount: toNano(1)}));

  spinner.succeed(`New account code installed`);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
