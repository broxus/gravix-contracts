import {Address, getRandomNonce, toNano, WalletTypes, zeroAddress} from "locklift";
import {deployUser, setupTokenRoot, setupVault} from "../test/utils/common";
import {Account} from "locklift/everscale-client";
import {MarketConfig, Oracle} from "../test/utils/wrappers/vault";

const {isValidEverAddress} = require('../test/utils/common');
const fs = require('fs');
const prompts = require('prompts');
const ora = require('ora');


const owner = new Address('0:311fe8e7bfeb6a2622aaba02c21569ac1e6f01c81c33f2623e5d8f1a5ba232d7');
const usdt = new Address('0:a6706285f0137339a14d7768a4843a5b7b2e3e4d82ef12371b4b2f4bc86eb73b');


const basic_config: MarketConfig = {
    priceSource: 1,
    maxLongsUSD: 100000000000, // 100k
    maxShortsUSD: 100000000000, // 100k
    noiWeight: 100,
    maxLeverage: 10000, // 100x
    depthAsset: 750000000000, // 25k
    fees: {
        openFeeRate: 1000000000, // 0.1%
        closeFeeRate: 1000000000, // 0.1%
        baseSpreadRate: 1000000000, // 0.1%
        baseDynamicSpreadRate: 500000000, // 0.05%
        borrowBaseRatePerHour: 50000000, // disable by default
        fundingBaseRatePerHour: 100000000 // disable by default
    },
    scheduleEnabled: false,
    workingHours: []
}

const oracle: Oracle = {
    chainlink: {addr: zeroAddress},
    dex: {
        // ever
        targetToken: new Address('0:a49cd4e158a9a15555e624759e2e4e766d22600b7800d891e46f9291f044a93d'),
        path: [
            {
                // ever - usdt
                addr: new Address('0:771e3d124c7a824d341484718fcf1af03dd4ba1baf280adeb0663bb030ce2bf9'),
                leftRoot: new Address('0:a49cd4e158a9a15555e624759e2e4e766d22600b7800d891e46f9291f044a93d'),
                rightRoot: new Address('0:a519f99bb5d6d51ef958ed24d337ad75a1c770885dcd42d51d6663f9fcdacfb2')
            }
        ]
    }
}

const main = async () => {
    const user = await deployUser(5);
    console.log('Deployed tmp admin');

    const stgUSDT = await setupTokenRoot('stgUSDT_test', 'stgUSDT_test', user);
    console.log('Deployed stgUSDT');

    const vault = await setupVault(
        user,
        {address: owner} as Account,
        usdt,
        stgUSDT.address
    );
    console.log('Deployed vault');

    await stgUSDT.transferOwnership({address: vault.address} as Account);
    console.log('Transferred stgUSDT ownership');

    await locklift.tracing.trace(vault.addMarkets([basic_config]));
    console.log('Added market');

    await locklift.tracing.trace(vault.setOracles([[0, oracle]]));
    console.log('Set oracle');
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
