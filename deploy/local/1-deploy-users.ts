import { getRandomNonce, toNano, WalletTypes } from "locklift";

//region migrating markets
//endregion
export default async () => {
    const [owner, user, user1] = await locklift.deployments.deployAccounts(
        [
            {
                deploymentName: "Owner", // user-defined custom account name
                signerId: "0", // locklift.keystore.getSigner("0") <- id for getting access to the signer
                accountSettings: {
                    type: WalletTypes.EverWallet,
                    value: locklift.utils.toNano(50000),
                },
            },
            {
                deploymentName: "User", // user-defined custom account name
                signerId: "1",
                accountSettings: {
                    type: WalletTypes.MsigAccount,
                    mSigType: "SafeMultisig",
                    contract: "TestWallet",
                    initParams: {
                        _randomNonce: getRandomNonce(),
                    },
                    value: locklift.utils.toNano(50000),
                    constructorParams: {
                        ownerPubkey: `0x${await locklift.keystore
                            .getSigner("1")
                            .then(res => res?.publicKey.toString())}`,
                    },
                },
            },

            {
                deploymentName: "User1", // user-defined custom account name
                signerId: "2",
                accountSettings: {
                    type: WalletTypes.EverWallet,
                    value: locklift.utils.toNano(50),
                },
            },
            {
                deploymentName: "LimitBot", // user-defined custom account name
                signerId: "2",
                accountSettings: {
                    nonce: getRandomNonce(),
                    type: WalletTypes.EverWallet,
                    value: locklift.utils.toNano(50),
                },
            },
        ],
        true, // enableLogs
    );

    await locklift.provider.sendMessage({
        sender: owner.account.address,
        recipient: owner.account.address,
        amount: toNano(1),
        bounce: false,
    });

    await locklift.provider.sendMessage({
        sender: user.account.address,
        recipient: user.account.address,
        amount: toNano(1),
        bounce: false,
    });

    await locklift.provider.sendMessage({
        sender: user1.account.address,
        recipient: user1.account.address,
        amount: toNano(1),
        bounce: false,
    });
};

export const tag = "users";
