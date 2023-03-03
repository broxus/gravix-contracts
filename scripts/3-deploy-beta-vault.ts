import {Address, toNano} from "locklift";
import {deployUser, setupTokenRoot, setupVault, sleep} from "../test/utils/common";
import {Account} from "locklift/everscale-client";
import {readFileSync} from "fs";

const owner = new Address('0:311fe8e7bfeb6a2622aaba02c21569ac1e6f01c81c33f2623e5d8f1a5ba232d7');
const usdt = new Address('0:a6706285f0137339a14d7768a4843a5b7b2e3e4d82ef12371b4b2f4bc86eb73b');
const oracle_contract = new Address('0:22cf895cb4b8864857858c967bfebebf713cfabe1893e71c9f1115d99b667e36');
const price_node = new Address('0:f471be9cca5d6921681c5b5d76b0d0adbc81757c3cf93efce87576316299cb96');
const oracle_pubkey = '123123';

const main = async () => {
    const user = await deployUser(10);
    console.log('Deployed tmp admin');

    const market_configs = JSON.parse(readFileSync('./setup.json').toString())
    const oracle_configs = JSON.parse(readFileSync('./oracle_setup.json').toString());

    const stgUSDT = await setupTokenRoot('stgUSDT_test', 'stgUSDT_test', user, 6);
    console.log('Deployed stgUSDT');

    const vault = await setupVault(
        user,
        {address: owner} as Account,
        usdt,
        stgUSDT.address,
        oracle_contract,
        price_node,
          oracle_pubkey
    );
    console.log('Deployed vault');

    await stgUSDT.transferOwnership({address: vault.address} as Account);
    console.log('Transferred stgUSDT ownership');

    await locklift.tracing.trace(vault.addMarkets(market_configs)
    );
    console.log('Added markets');

    await locklift.tracing.trace(vault.setOracles(
        oracle_configs.map((conf: any, idx: any) => [idx, conf])
        )
    );
    console.log('Set oracle');

    await vault.contract.methods.transferOwnership(
        {new_owner: owner, meta: {call_id: 0, send_gas_to: owner, nonce: 0}}
    ).send({from: user.address, amount: toNano(2)});
    console.log('Ownership transferred');
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
