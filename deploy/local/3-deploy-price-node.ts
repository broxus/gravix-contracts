import { getRandomNonce, toNano } from "locklift";

export default async () => {
    const signer = await locklift.keystore.getSigner("0");
    const { account: owner } = await locklift.deployments.getAccount("Owner");

    await locklift.deployments.deploy({
        deploymentName: "PriceNode",
        deployConfig: {
            contract: "PriceNode",
            initParams: { deployNonce: getRandomNonce() },
            constructorParams: {
                _owner: owner.address,
                _daemonPubkey: `0x${signer?.publicKey}`,
                _oraclePubkey: `0x${signer?.publicKey}`,
            },
            publicKey: signer?.publicKey as string,
            value: toNano(1),
        },
        enableLogs: true,
    });

    const { traceTree } = await locklift.tracing.trace(
        locklift.deployments.deploy({
            deploymentName: "PriceNodeMock",
            deployConfig: {
                contract: "PriceNodeMock",
                value: toNano(1),
                constructorParams: {
                    _owner: owner.address,
                    _daemonPubkey: `0x${signer?.publicKey}`,
                    _oraclePubkey: `0x${signer?.publicKey}`,
                },
                publicKey: signer?.publicKey as string,
                initParams: { deployNonce: getRandomNonce() },
            },
            enableLogs: true,
        }),
    );
};

export const tag = "price_node";
