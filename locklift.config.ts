import { LockliftConfig } from "locklift";
import { FactorySource } from "./build/factorySource";
import * as dotenv from "dotenv";
import "locklift-verifier";
import "locklift-deploy";
import { Deployments } from "locklift-deploy";
dotenv.config();

declare global {
    const locklift: import("locklift").Locklift<FactorySource>;
}
declare module "locklift" {
    //@ts-ignore
    export interface Locklift {
        deployments: Deployments<FactorySource>;
    }
}
const LOCAL_NODE_URL = process.env.LOCAL_NODE_URL || "http://localhost";

const config: LockliftConfig = {
    verifier: {
        verifierVersion: "latest", // contract verifier binary, see https://github.com/broxus/everscan-verify
        apiKey: process.env.VERIFIER_KEY || "",
        secretKey: process.env.VERIFIER_SECRET || "",
        // license: "AGPL-3.0-or-later", <- this is default value and can be overrided
    },
    compiler: {
        // Specify path to your TON-Solidity-Compiler
        // path: "/mnt/o/projects/broxus/TON-Solidity-Compiler/build/solc/solc",

        // Or specify version of compiler
        version: "0.62.0",

        // Specify config for external contracts as in example
        externalContracts: {
            "node_modules/@broxus/tip3/contracts": [
                "TokenRootUpgradeable",
                "TokenWalletUpgradeable",
                "TokenWalletPlatform",
            ],
        },
    },
    linker: {
        // Specify path to your stdlib
        // lib: "/mnt/o/projects/broxus/TON-Solidity-Compiler/lib/stdlib_sol.tvm",
        // // Specify path to your Linker
        // path: "/mnt/o/projects/broxus/TVM-linker/target/release/tvm_linker",

        // Or specify version of linker
        version: "0.15.48",
    },
    networks: {
        locklift: {
            deploy: ["local/"],
            connection: {
                id: 1001,
                // @ts-ignore
                type: "proxy",
                // @ts-ignore
                data: {},
            },
            keys: {
                // Use everdev to generate your phrase
                // !!! Never commit it in your repos !!!
                // phrase: "action inject penalty envelope rabbit element slim tornado dinner pizza off blood",
                amount: 20,
            },
        },
        local: {
            deploy: ["local/"],
            // Specify connection settings for https://github.com/broxus/everscale-client/
            connection: {
                group: "localnet",
                // @ts-ignore
                type: "graphql",
                data: {
                    // @ts-ignore
                    endpoints: [`${LOCAL_NODE_URL}/graphql`],
                    latencyDetectionInterval: 1000,
                    local: true,
                },
            },
            // This giver is default local-node giverV2
            giver: {
                address: "0:ece57bcc6c530283becbbd8a3b24d3c5987cdddc3c8b7b33be6e4a6312490415",
                key: "172af540e43a524763dd53b26a066d472a97c4de37d5498170564510608250c3",
            },
            tracing: {
                endpoint: `${LOCAL_NODE_URL}/graphql`,
            },

            keys: {
                // Use everdev to generate your phrase
                // !!! Never commit it in your repos !!!
                phrase: process.env.LOCAL_PHRASE,
                amount: 500,
            },
        },
        test: {
            // Specify connection settings for https://github.com/broxus/everscale-standalone-client/
            connection: {
                // @ts-ignore
                type: "graphql",
                data: {
                    // @ts-ignore
                    endpoints: [process.env.TEST_GQL_ENDPOINT],
                },
            },
            // This giver is default local-node giverV2
            giver: {
                address: "0:a4053fd2e9798d0457c9e8f012cef203e49da863d76f36d52d5e2e62c326b217",
                key: process.env.TESTNET_GIVER_KEY ?? "",
            },
            tracing: {
                endpoint: process.env.TEST_GQL_ENDPOINT
            },

            keys: {
                // Use everdev to generate your phrase
                // !!! Never commit it in your repos !!!
                // phrase: "action inject penalty envelope rabbit element slim tornado dinner pizza off blood",
                amount: 500,
            },
        },
        main: {
            deploy: ["common/", "main/"],
            connection: "mainnetJrpc",
            giver: {
                address: "0:3bcef54ea5fe3e68ac31b17799cdea8b7cffd4da75b0b1a70b93a18b5c87f723",
                key: process.env.MAIN_GIVER_KEY ?? "",
            },
            keys: {
                phrase: process.env.MAIN_SEED_PHRASE ?? "",
                amount: 500,
            },
        },
        venom: {
            deploy: ["common/", "venom-test/"],
            connection: {
                id: 1000,
                type: "jrpc",
                data: {
                    endpoint: process.env.MAIN_RPC_ENDPOINT || "",
                },
            },
            giver: {
                address: "0:73a868302a14a05ee6de24eed367bd42e7cd345406bb12e5fc6749de91a579ff",
                phrase: process.env.MAIN_SEED_PHRASE ?? "",
                accountId: 0,
            },
            keys: {
                phrase: process.env.MAIN_SEED_PHRASE ?? "",
                amount: 500,
            },
        },
    },
    mocha: {
        timeout: 3000000,
        bail: true,
    },
};

export default config;
