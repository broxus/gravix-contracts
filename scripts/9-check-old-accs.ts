import {Address, toNano} from "locklift";
import {isValidEverAddress} from "../test/utils/common";
const fs = require('fs');

const prompts = require('prompts');
const ora = require('ora');


const cur_code_hash = '6e1ea15cd427afd627b886c234c9f873f43e2cd068b7f45e67ea704ed7119571';

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
  let continuation: string | undefined; // just not undefined
  while (true) {
    const accs = await locklift.provider.getAccountsByCodeHash({
      codeHash: cur_code_hash, continuation: continuation
    });
    all_old_accs = all_old_accs.concat(accs.accounts);
    continuation = accs.continuation;
    if (!continuation) break;
  }

  fs.writeFileSync('all_old_accs.json', JSON.stringify(all_old_accs, null, 2));


  var uSet = new Set(all_old_accs);
  console.log('Raw', uSet.size);
  // this will work only if getDetails method is not changed, otherwise 60 error will be thrown
  let vault_old_accs: Address[] = [];
  for (const acc of Array.from(uSet)) {
    const account = await locklift.factory.getDeployedContract('GravixAccount', acc);
    const details = await account.methods.getDetails({answerId: 0}).call();
    console.log('call')
    if (details._vault.equals(vault.address)) {
      vault_old_accs.push(acc);
    }
  }

  spinner.succeed(`Found ${vault_old_accs.length} old accounts`);
  console.log(vault_old_accs);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
