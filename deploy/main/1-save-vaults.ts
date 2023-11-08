export default async () => {
    await locklift.deployments.saveContract({
        deploymentName: "prod_Vault",
        address: "0:79f285cdc6522a78e9025453a547bed817a4a6b8ca548c39ddc5591b42a59113",
        contractName: "GravixVault",
    });
    await locklift.deployments.saveContract({
        deploymentName: "beta_Vault",
        address: "0:0246f10dbb1ac07b63963eb78660d16c4b23661edb8211fd0ef5e2e178225fa6",
        contractName: "GravixVault",
    });

    console.log("\x1b[1m", "Vaults saved to deploy artifacts");
};

export const tag = "save_vaults";
