import { Token } from "./wrappers/token";
import { Address, Contract, getRandomNonce, toNano, WalletTypes, zeroAddress } from "locklift";
import { Account } from "locklift/everscale-client";
import { GravixVault } from "./wrappers/vault";
import Bignumber from "bignumber.js";

const logger = require("mocha-logger");
const { expect } = require("chai");

export function isNumeric(value: string) {
    return /\d+$/.test(value);
}

export const isValidEverAddress = (address: string) => /^(?:-1|0):[0-9a-fA-F]{64}$/.test(address);

export async function sleep(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function bn(num: number | string) {
    return new Bignumber(num);
}

export function toUSD(num: Bignumber | number) {
    const val = num.toString();
    return bn(val)
        .div(10 ** 6)
        .toFixed(5);
}

export async function tryIncreaseTime(seconds: number) {
    // @ts-ignore
    // if (locklift.testing.isEnabled) {
    //     await locklift.testing.increaseTime(seconds);
    // } else {
    await sleep(seconds * 1000);
    // }
}

export const sendAllEvers = async function (from: Account, to: Address) {
    const walletContract = await locklift.factory.getDeployedContract("TestWallet", from.address);
    return await locklift.tracing.trace(
        walletContract.methods
            .sendTransaction({
                dest: to,
                value: 0,
                bounce: false,
                flags: 128,
                payload: "",
                // @ts-ignore
            })
            .sendExternal({ publicKey: from.publicKey }),
        { allowedCodes: { compute: [null] } },
    );
};

// allow sending N internal messages via batch method
export const runTargets = async function (
    wallet: Account,
    targets: Contract<any>[],
    methods: string[],
    params_list: Object[],
    values: any[],
) {
    let bodies = await Promise.all(
        targets.map(async function (target, idx) {
            const method = methods[idx];
            const params = params_list[idx];
            // @ts-ignore
            return await target.methods[method](params).encodeInternal();
        }),
    );

    const walletContract = await locklift.factory.getDeployedContract("TestWallet", wallet.address);

    return await walletContract.methods
        .sendTransactions({
            dest: targets.map(contract => contract.address),
            value: values,
            bounce: new Array(targets.length).fill(true),
            flags: new Array(targets.length).fill(0),
            payload: bodies,
            // @ts-ignore
        })
        .sendExternal({ publicKey: wallet.publicKey });
};

export const deployUsers = async function (count: number, initial_balance: number) {
    // @ts-ignore
    let signers = await Promise.all(
        Array.from(Array(count).keys()).map(async i => await locklift.keystore.getSigner(i.toString())),
    );
    signers = signers.slice(0, count);

    let signers_map = {};
    signers.map(signer => {
        // @ts-ignore
        signers_map[`0x${signer.publicKey}`.toLowerCase()] = signer;
    });

    const TestWallet = await locklift.factory.getContractArtifacts("TestWallet");
    const { contract: factory, tx } = await locklift.factory.deployContract({
        contract: "TestFactory",
        initParams: { walletCode: TestWallet.code, _randomNonce: getRandomNonce() },
        publicKey: signers[0]?.publicKey as string,
        constructorParams: {},
        value: toNano(count * initial_balance + 10),
    });

    const pubkeys = signers.map(signer => {
        return `0x${signer?.publicKey}`;
    });
    const values = Array(count).fill(toNano(initial_balance));

    const chunkSize = 60;
    for (let i = 0; i < count; i += chunkSize) {
        const _pubkeys = pubkeys.slice(i, i + chunkSize);
        const _values = values.slice(i, i + chunkSize);
        await locklift.tracing.trace(
            factory.methods
                .deployUsers({
                    pubkeys: _pubkeys,
                    values: _values,
                })
                .sendExternal({ publicKey: signers[0]?.publicKey as string }),
        );
    }

    // await sleep(1000);
    const { wallets } = await factory.methods.wallets({}).call();
    return await Promise.all(
        wallets.map(async wallet => {
            return await locklift.factory.accounts.addExistingAccount({
                publicKey: wallet[0].slice(2),
                type: WalletTypes.MsigAccount,
                mSigType: "SafeMultisig",
                address: wallet[1],
            });
        }),
    );
};

export const deployUser = async function (initial_balance = 100, log = true): Promise<Account> {
    const signer = await locklift.keystore.getSigner("0");

    const { account: _user, tx } = await locklift.factory.accounts.addNewAccount({
        type: WalletTypes.MsigAccount,
        mSigType: "SafeMultisig",
        contract: "TestWallet",
        //Value which will send to the new account from a giver
        value: toNano(initial_balance),
        publicKey: signer?.publicKey as string,
        initParams: {
            _randomNonce: getRandomNonce(),
        },
        constructorParams: {
            ownerPubkey: `0x${signer?.publicKey}`,
        },
    });

    if (log) logger.log(`User address: ${_user.address.toString()}`);
    return _user;
};

export const setupTokenRoot = async function (token_name: string, token_symbol: string, owner: Account, decimals = 9) {
    const signer = await locklift.keystore.getSigner("0");
    const TokenPlatform = await locklift.factory.getContractArtifacts("TokenWalletPlatform");

    const TokenWallet = await locklift.factory.getContractArtifacts("TokenWalletUpgradeable");
    const { contract: _root, tx } = await locklift.tracing.trace(
        locklift.factory.deployContract({
            contract: "TokenRootUpgradeable",
            initParams: {
                name_: token_name,
                symbol_: token_symbol,
                decimals_: decimals,
                rootOwner_: owner.address,
                walletCode_: TokenWallet.code,
                randomNonce_: getRandomNonce(),
                deployer_: zeroAddress,
                platformCode_: TokenPlatform.code,
            },
            publicKey: signer?.publicKey as string,
            constructorParams: {
                initialSupplyTo: zeroAddress,
                initialSupply: 0,
                deployWalletValue: 0,
                mintDisabled: false,
                burnByRootDisabled: false,
                burnPaused: false,
                remainingGasTo: owner.address,
            },
            value: locklift.utils.toNano(2),
        }),
    );

    logger.log(`Token root address: ${_root.address.toString()}`);

    expect(Number(await locklift.provider.getBalance(_root.address))).to.be.above(0, "Root balance empty");
    return new Token(_root, owner);
};

export const setupVault = async function (
    owner: Account,
    usdt: Address,
    stg_usdt: Address,
    oracle: Address,
    priceNode: Address,
    pricePk: string,
    log = true,
) {
    const signer = await locklift.keystore.getSigner("0");

    const OracleProxy = await locklift.factory.getContractArtifacts("OracleProxy");
    const Platform = await locklift.factory.getContractArtifacts("Platform");
    const GravixAccount = await locklift.factory.getContractArtifacts("GravixAccount");
    const GravixVaultArtifacts = await locklift.factory.getContractArtifacts("GravixVault");

    const { contract: _deployer, tx } = await locklift.tracing.trace(
        locklift.factory.deployContract({
            contract: "VaultDeployer",
            initParams: {
                deployNonce: getRandomNonce(),
            },
            publicKey: signer?.publicKey as string,
            constructorParams: {
                _vault: GravixVaultArtifacts.code,
                _platform: Platform.code,
                _account: GravixAccount.code,
                _proxy: OracleProxy.code,
            },
            value: toNano(5),
        }),
    );

    const { traceTree, transaction, output } = await locklift.tracing.trace(
        _deployer.methods
            .deployVault({
                _owner: owner.address,
                _usdt: usdt,
                _stg_usdt: stg_usdt,
                _priceNode: priceNode,
                _pricePubkey: pricePk,
            })
            .sendExternal({ publicKey: signer?.publicKey as string }),
    );

    if (log) logger.log(`Gravix Vault address: ${output!.value0.toString()}`);
    return GravixVault.from_addr(output!.value0, owner);
};

export const setupPairMock = async function () {
    const signer = await locklift.keystore.getSigner("0");

    const { contract: mock, tx } = await locklift.tracing.trace(
        locklift.factory.deployContract({
            contract: "PairMock",
            initParams: {
                deployNonce: getRandomNonce(),
            },
            publicKey: signer?.publicKey as string,
            constructorParams: {},
            value: toNano(1),
        }),
    );

    return mock;
};
