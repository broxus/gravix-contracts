import {Address, toNano} from "locklift";
import {isValidEverAddress} from "../test/utils/common";

const prompts = require('prompts');
const ora = require('ora');


const cur_code_hash = '3a62e1fdf81fc00146fcf799a8ed0e0de54a7677a4c27e4e54fbee047fc1a856';

const main = async () => {
  await locklift.deployments.load();

  console.log('\x1b[1m', '\n\nUpgrade vault accounts:')
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

  const spinner = ora('Fetching old accounts...').start();

  let old_accs: Address[] = [];
  let continuation: string | undefined = '123';
  while (continuation) {
    const accs = await locklift.provider.getAccountsByCodeHash({
      codeHash: cur_code_hash
    });
    old_accs = old_accs.concat(accs.accounts);
    continuation = accs.continuation;
  }
  spinner.succeed(`Found ${old_accs.length} old accounts`);

  spinner.start('Upgrading accounts...');
  while (old_accs.length) {
    const pack = old_accs.splice(0, 50);
    await locklift.tracing.trace(vault.methods.forceUpgradeGravixAccountsByContracts({
      contracts: pack, meta: {call_id: 0, nonce: 0, send_gas_to: manager.address}
    }).send({from: manager.address, amount: toNano(pack.length + 2)}));
    console.log('\x1b[1m', `Upgraded ${pack.length} accounts`)
  }
  spinner.succeed(`All accounts upgraded`);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
