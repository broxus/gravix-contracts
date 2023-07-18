import { setupVault } from "../../test/utils/common";
import { Account } from "locklift/everscale-client";
import { TokenRootUpgradeableAbi } from "../../build/factorySource";
import { Token } from "../../test/utils/wrappers/token";

export default async () => {
    const signer = await locklift.keystore.getSigner("0");
    const { account: owner } = await locklift.deployments.getAccount("Owner");

    const usdt_root = await locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT");
    const stg_root = await locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT");
    const priceNode = await locklift.deployments.getContract("PriceNode");

    const vault = await setupVault(
        owner,
        usdt_root.address,
        stg_root.address,
        owner.address,
        priceNode.address,
        `0x${signer?.publicKey}`,
    );

    const stg = await Token.from_addr(stg_root.address, owner);
    // now transfer ownership of stgTOKEN to vault
    await stg.transferOwnership({ address: vault.address } as Account);

    await locklift.deployments.saveContract({
        deploymentName: "Vault",
        address: vault.address,
        contractName: "GravixVault",
    });
};

export const tag = "vault";
