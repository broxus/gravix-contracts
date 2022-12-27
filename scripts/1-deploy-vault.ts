import {getRandomNonce, toNano, WalletTypes} from "locklift";
import {setupVault} from "../test/utils/common";
import {Account} from "locklift/everscale-client";

const {isValidEverAddress} = require('../test/utils/common');
const fs = require('fs');
const prompts = require('prompts');
const ora = require('ora');


const main = async () => {
    console.log('\x1b[1m', '\n\nDeploy Gravix Vault:')
    const response = await prompts([
        {
            type: 'text',
            name: '_owner',
            message: 'Gravix Vault owner address',
            validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
        },
        {
            type: 'text',
            name: '_market_manager',
            message: 'Gravix Vault market manager address',
            validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
        },
        {
            type: 'text',
            name: '_usdt',
            message: 'USDT root address',
            validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
        },
        {
            type: 'text',
            name: '_stg_usdt',
            message: 'stgUSDT root address',
            validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
        },
        {
            type: 'text',
            name: '_oracle',
            message: 'Oracle contract address',
            validate: (value: string) => isValidEverAddress(value) ? true : 'Invalid Everscale address'
        }
    ]);
    console.log('\x1b[1m', '\nSetup complete! ✔');

    const spinner = ora('Deploying vault...').start();
    const vault = await setupVault(
        {address: response._owner} as Account,
        {address: response._market_manager} as Account,
        response._usdt,
        response._stg_usdt,
        response._oracle
    );
    spinner.succeed(`Gravix Vault deployed: ${vault.address}`);
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
