import {Address, toNano, zeroAddress} from "locklift";
import {deployUser, setupTokenRoot, setupVault} from "../test/utils/common";
import {Account} from "locklift/everscale-client";
import {MarketConfig, Oracle} from "../test/utils/wrappers/vault";

const owner = new Address('0:311fe8e7bfeb6a2622aaba02c21569ac1e6f01c81c33f2623e5d8f1a5ba232d7');
const usdt = new Address('0:a6706285f0137339a14d7768a4843a5b7b2e3e4d82ef12371b4b2f4bc86eb73b');


const basic_config: MarketConfig = {
    priceSource: 1,
    maxLongsUSD: 100000000000, // 100k
    maxShortsUSD: 100000000000, // 100k
    noiWeight: 100,
    maxLeverage: 20000, // 200x
    depthAsset: 750000000000, // 750k
    fees: {
        openFeeRate: 1000000000, // 0.1%
        closeFeeRate: 1000000000, // 0.1%
        baseSpreadRate: 1000000000, // 0.1%
        baseDynamicSpreadRate: 1000000000, // 0.1%
        borrowBaseRatePerHour: 50000000, // 0.005%de
        fundingBaseRatePerHour: 100000000 // disable by default
    },
    scheduleEnabled: false,
    workingHours: []
}

const basic_config2: MarketConfig = {
    priceSource: 1,
    maxLongsUSD: 100000000000, // 100k
    maxShortsUSD: 100000000000, // 100k
    noiWeight: 100,
    maxLeverage: 20000, // 200x
    depthAsset: 750000000000, // 750k
    fees: {
        openFeeRate: 2000000000, // 0.2%
        closeFeeRate: 2000000000, // 0.2%
        baseSpreadRate: 2000000000, // 0.2%
        baseDynamicSpreadRate: 2000000000, // 0.1%
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

const oracle2: Oracle = {
    chainlink: {addr: zeroAddress},
    dex: {
        // qube
        targetToken: new Address('0:9f20666ce123602fd7a995508aeaa0ece4f92133503c0dfbd609b3239f3901e2'),
        path: [
            {   // qube - ever
                addr: new Address('0:c8021e99e5329cd863ed206e2729be28586dc2ab398ed4d5f2bbddf2f44d8b01'),
                leftRoot: new Address('0:9f20666ce123602fd7a995508aeaa0ece4f92133503c0dfbd609b3239f3901e2'),
                rightRoot: new Address('0:a49cd4e158a9a15555e624759e2e4e766d22600b7800d891e46f9291f044a93d')
            },
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
    const user = await deployUser(7);
    console.log('Deployed tmp admin');

    const stgUSDT = await setupTokenRoot('stgUSDT_test', 'stgUSDT_test', user, 6);
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

    await locklift.tracing.trace(vault.addMarkets([basic_config, basic_config2]));
    console.log('Added market');

    await locklift.tracing.trace(vault.setOracles([[0, oracle], [1, oracle2]]));
    console.log('Set oracle');

    await vault.contract.methods.transferOwnership(
        {new_owner: owner, meta: {call_id: 0, send_gas_to: owner, nonce: 0}}
    ).send({from: user.address, amount: toNano(1)});
    console.log('Ownership transferred');

    await vault.contract.methods.deployGravixAccount(
        {user: owner, meta: {call_id: 0, nonce: 0, send_gas_to: owner}, answerId: 0}
    ).send({from: user.address, amount: toNano(1)});

    await vault.contract.methods.deployGravixAccount(
        {user: new Address('0:ef8635871613be03181667d967fceda1b4a1d98e6811552d2c31adfc2cbcf9b1'), meta: {call_id: 0, nonce: 0, send_gas_to: owner}, answerId: 0}
    ).send({from: user.address, amount: toNano(1)});
};
main()
    .then(() => process.exit(0))
    .catch(e => {
        console.log(e);
        process.exit(1);
    });
