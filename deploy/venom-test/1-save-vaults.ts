import {toNano, WalletTypes} from "locklift";


export default async () => {
    await locklift.deployments.saveContract({
      deploymentName: "beta_Vault",
      address: "0:56f3905165dba389b559b5c423546b25ad09de2f6009f6749a6c5be9a0bfcaa2",
      contractName: "GravixVault"
    });
    console.log('\x1b[1m', 'Vaults saved to deploy artifacts');
};

export const tag = "save_vaults";