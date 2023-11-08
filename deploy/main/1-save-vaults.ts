export default async () => {
    await locklift.deployments.saveContract({
        deploymentName: "prod_Vault",
        address: "0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113",
        contractName: "GravixVault",
    });
    await locklift.deployments.saveContract({
        deploymentName: "beta_Vault",
        address: "0:6621e0d891f2f73e1be31cd8a92b34a4a5f51d9bdabbedd20e0d82cdc7a03dad",
        contractName: "GravixVault",
    });

    console.log("\x1b[1m", "Vaults saved to deploy artifacts");
};

export const tag = "save_vaults";
