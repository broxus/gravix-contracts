import {getRandomNonce} from "locklift";
import {setupTokenRoot} from "../../test/utils/common";


export default async () => {
  const token_name = `TOKEN_${getRandomNonce()}`;
  const stg_token_name = `stg${token_name}`;

  const {account:owner} = await locklift.deployments.getAccount('Owner');
  const {account:user} = await locklift.deployments.getAccount('User');

  const usdt_root = await setupTokenRoot(token_name, token_name, owner, 6);
  const stg_root = await setupTokenRoot(stg_token_name, stg_token_name, owner, 6);

  const USDT_DECIMALS = 10 ** 6;
  await usdt_root.mint(1000000000 * USDT_DECIMALS, owner);
  await usdt_root.mint(1000000000 * USDT_DECIMALS, user);

  await locklift.deployments.saveContract({
    deploymentName: "USDT",
    address: usdt_root.address,
    contractName: "TokenRootUpgradeable"
  });

  await locklift.deployments.saveContract({
    deploymentName: "StgUSDT",
    address: stg_root.address,
    contractName: "TokenRootUpgradeable"
  });
};

export const tag = "tokens";