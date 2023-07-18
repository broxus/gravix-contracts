import { toNano, WalletTypes } from "locklift";

export default async () => {
    await locklift.deployments.saveContract({
        deploymentName: "prod_Vault",
        address: "0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113",
        contractName: "GravixVault",
    });
    await locklift.deployments.saveContract({
        deploymentName: "beta_Vault",
        address: "0:0ebb6c1d80bf0bc34f4eaa6880c1b37af83b3e2cc3b4943ce71d33a7820ba4e5",
        contractName: "GravixVault",
    });

    console.log("\x1b[1m", "Vaults saved to deploy artifacts");
};

export const tag = "save_vaults";
