import {Address, toNano} from "locklift";
import {isValidEverAddress} from "../test/utils/common";

const prompts = require('prompts');
const ora = require('ora');


const cur_code_hash = '3a62e1fdf81fc00146fcf799a8ed0e0de54a7677a4c27e4e54fbee047fc1a856';

const main = async () => {
  await locklift.deployments.load();

  console.log('\x1b[1m', '\n\nCheck old vault accounts:')
  const response = await prompts([
    {
      type: 'text',
      name: 'vault',
      message: 'Vault address',
      validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
    }
  ]);
  const vault = await locklift.factory.getDeployedContract('GravixVault', response.vault);

  const spinner = ora('Fetching old accounts...').start();
  let all_old_accs: Address[] = [];
  let continuation: string | undefined = '123'; // just not undefined
  while (continuation) {
    const accs = await locklift.provider.getAccountsByCodeHash({
      codeHash: cur_code_hash
    });
    all_old_accs = all_old_accs.concat(accs.accounts);
    continuation = accs.continuation;
  }

  // this will work only if getDetails method is not changed, otherwise 60 error will be thrown
  let vault_old_accs: Address[] = [];
  for (const acc of all_old_accs) {
    const account = await locklift.factory.getDeployedContract('GravixAccount', acc);
    const details = await account.methods.getDetails({answerId: 0}).call();
    if (details._vault === vault.address) {
      vault_old_accs.push(acc);
    }
  }

  spinner.succeed(`Found ${vault_old_accs.length} old accounts`);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
