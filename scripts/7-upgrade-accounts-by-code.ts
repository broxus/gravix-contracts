import {Address, toNano} from "locklift";
import {isValidEverAddress} from "../test/utils/common";
import {GravixVaultAbi} from "../build/factorySource";

const prompts = require('prompts');
const ora = require('ora');


const cur_code_hash = '6e1ea15cd427afd627b886c234c9f873f43e2cd068b7f45e67ea704ed7119571';

const main = async () => {
  await locklift.deployments.load();

  console.log('\x1b[1m', '\n\nUpgrade vault accounts:')
  const response = await prompts([
    {
      type: 'select',
      name: 'vault',
      message: 'Select vault to upgrade',
      choices: [
        {title: 'prod', value: 'prod_Vault'},
        {title: 'beta', value: 'beta_Vault'}
      ],
      validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
    }
  ]);
  const manager = await locklift.deployments.getAccount('Manager').account;
  console.log('\x1b[1m', `\nGet manager from deployments: ${manager.address}`);

  const vault = await locklift.deployments.getContract<GravixVaultAbi>(response.vault);
  console.log(`Get vault from deployments: ${vault.address}`);
  const spinner = ora('Fetching old accounts...').start();

  let old_accs: Address[] = [];
  let continuation: string | undefined; // just not undefined
  while (true) {
    const accs = await locklift.provider.getAccountsByCodeHash({
      codeHash: cur_code_hash, continuation: continuation
    });
    old_accs = old_accs.concat(accs.accounts);
    continuation = accs.continuation;
    if (!continuation) break;
  }
  spinner.succeed(`Found ${old_accs.length} old accounts`);

  spinner.start('Upgrading accounts...');
  while (old_accs.length) {
    const pack = old_accs.splice(0, 30);
    await locklift.transactions.waitFinalized(vault.methods.forceUpgradeGravixAccountsByContracts({
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
