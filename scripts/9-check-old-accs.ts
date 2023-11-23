import { Address, toNano } from "locklift";
import {getAccountsByCodeHash, isValidEverAddress} from "../test/utils/common";
const fs = require("fs");

const prompts = require("prompts");
const ora = require("ora");

const cur_code_hash = "e35c25eed033cb19e9b7a029471cdaa2ff653d4362e6d081b2b02e3c863ec4af";



const main = async () => {
    await locklift.deployments.load();

    console.log("\x1b[1m", "\n\nCheck old vault accounts:");
    const response = await prompts([
        {
            type: "text",
            name: "vault",
            message: "Vault address",
            validate: (value: string) => (isValidEverAddress(value) ? true : "Invalid Everscale address"),
        },
    ]);
    const vault = await locklift.factory.getDeployedContract("GravixVault", response.vault);

    const spinner = ora("Fetching old accounts...").start();
    let all_old_accs: Address[] = [];
    let continuation: string | undefined; // just not undefined
    while (true) {
        const accs = await getAccountsByCodeHash(cur_code_hash, continuation);
        all_old_accs = all_old_accs.concat(accs.accounts);
        continuation = accs.continuation;
        if (all_old_accs.length % 500 === 0) console.log('Collect progress:', all_old_accs.length);
        if (!continuation) break;
    }

    fs.writeFileSync("all_old_accs.json", JSON.stringify(all_old_accs, null, 2));

    var uSet = new Set(all_old_accs);
    console.log("Raw", uSet.size);
    // this will work only if getDetails method is not changed, otherwise 60 error will be thrown
    let vault_old_accs: Address[] = [];
    let vault_old_users = [];
    for (const acc of Array.from(uSet)) {
        const account = await locklift.factory.getDeployedContract("GravixAccount", acc);
        const details = await account.methods.getDetails({ answerId: 0 }).call();
        if (details._vault.equals(vault.address)) {
            vault_old_accs.push(acc);
            vault_old_users.push(details._user);
        }
    }
    spinner.succeed(`Found ${vault_old_accs.length} old accounts`);

    fs.writeFileSync("all_old_users.json", JSON.stringify(vault_old_users, null, 2));
};

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
