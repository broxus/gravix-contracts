import { setupVault } from "../../test/utils/common";
import { Account } from "locklift/everscale-client";
import { GravixVaultAbi, TokenRootUpgradeableAbi } from "../../build/factorySource";
import { Token } from "../../test/utils/wrappers/token";
import { getRandomNonce, toNano } from "locklift";

export default async () => {
    const signer = await locklift.keystore.getSigner("0");
    const { account: owner } = await locklift.deployments.getAccount("Owner");
    const { account: limitBot } = await locklift.deployments.getAccount("LimitBot");

    const usdt_root = await locklift.deployments.getContract<TokenRootUpgradeableAbi>("USDT");
    const stg_root = await locklift.deployments.getContract<TokenRootUpgradeableAbi>("StgUSDT");
    const priceNode = await locklift.deployments.getContract("PriceNode");

    const vault = await setupVault({
        owner: owner,
        usdt: usdt_root.address,
        stg_usdt: stg_root.address,
        priceNode: priceNode.address,
        limitBot: limitBot.address,
        pricePk: `0x${signer?.publicKey}`,
        log: true
    });
    const { contract: limitBotVault } = await locklift.deployments.deploy({
        deploymentName: "LimitBotVault",
        enableLogs: true,
        deployConfig: {
            contract: "LimitBotVault",
            publicKey: signer?.publicKey!,
            initParams: {
                nonce: getRandomNonce(),
            },
            constructorParams: {
                _gravixVault: vault.address,
                _owner: owner.address,
            },
            value: toNano(2),
        },
    });
    const stg = await Token.from_addr(stg_root.address, owner);
    // now transfer ownership of stgTOKEN to vault
    await stg.transferOwnership({ address: vault.address } as Account);

    await locklift.deployments.saveContract({
        deploymentName: "Vault",
        address: vault.address,
        contractName: "GravixVault",
    });

    const vault_contract = locklift.deployments.getContract<GravixVaultAbi>("Vault");

    await vault_contract.methods
        .setLimitBotVault({
            _meta: {
                callId: 0,
                nonce: getRandomNonce(),
                sendGasTo: owner.address,
            },
            _newLimitBotVault: limitBotVault.address,
        })
        .send({
            from: owner.address,
            amount: toNano(2),
        });
};

export const tag = "vault";
