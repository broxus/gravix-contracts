import {setupPairMock} from "../../test/utils/common";


export default async () => {
  const eth_usdt_mock = await setupPairMock();
  const btc_eth_mock = await setupPairMock();

  await locklift.deployments.saveContract({
    address: eth_usdt_mock.address,
    contractName: "PairMock",
    deploymentName: "ETH_USDT"
  });

  await locklift.deployments.saveContract({
    address: btc_eth_mock.address,
    contractName: "PairMock",
    deploymentName: "BTC_ETH"
  });
};

export const tag = "mocks";