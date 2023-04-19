import {toNano, WalletTypes} from "locklift";


export default async () => {
  const [ manager] = await locklift.deployments.deployAccounts([
      {
        deploymentName: "Manager", // user-defined custom account name
        signerId: "10", // locklift.keystore.getSigner("0") <- id for getting access to the signer
        accountSettings: {
          type: WalletTypes.EverWallet,
          value: locklift.utils.toNano(50),
        },
      }
    ],
    true // enableLogs
  );

  await locklift.provider.sendMessage({
    sender: manager.account.address,
    recipient: manager.account.address,
    amount: toNano(1),
    bounce: false,
  });

  console.log('\x1b[1m', "\n\nManager address: ", manager.account.address);
};

export const tag = "manager";