import {toNano, WalletTypes} from "locklift";


export default async () => {
    await locklift.deployments.saveContract({
      deploymentName: "prod_Vault",
      address: "0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113",
      contractName: "GravixVault"
    });
    await locklift.deployments.saveContract({
      deploymentName: "beta_Vault",
      address: "0:b6d922019199afae2c12f5e58be396c8c3b375b36c1ca58305318e6b0a69259c",
      contractName: "GravixVault"
    });

    console.log('\x1b[1m', 'Vaults saved to deploy artifacts');
};

export const tag = "save_vaults";