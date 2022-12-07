const {isValidEverAddress} = require('../test/utils/common');
const fs = require('fs');
const prompts = require('prompts');
const ora = require('ora');


const main = async () => {
    const vault = await locklift.factory.getContractArtifacts('GravixVault');
    console.log('Vault\n', vault.code);

    const oracle = await locklift.factory.getContractArtifacts('OracleProxy');
    console.log('\nOracle\n', oracle.code);
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
