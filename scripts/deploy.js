const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const {
    LENDING_POOL,
    UNISWAP_V2_ROUTER,
    SUSHI_ROUTER,
    UNISWAP_V3_ROUTER,
    DAI_ADDRESS,
    FLASH_LOAN_PREMIUM,
    SLIPPAGE_TOLERANCE,
    CHAINLINK_ORACLE,
    AXELAR_GATEWAY,
    WETH_ADDRESS,
    PROFIT_THRESHOLD
  } = process.env;

  const [deployer] = await ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  // 1) Deploy Modules
  const BridgeFactory = await ethers.getContractFactory("BridgeModule");
  const bridge = await BridgeFactory.deploy(AXELAR_GATEWAY, DAI_ADDRESS);
  await bridge.waitForDeployment();
  console.log("BridgeModule at:", await bridge.getAddress());

  const HedgingFactory = await ethers.getContractFactory("HedgingModule");
  // For the “Bart9Figures,” we often do DAI->WETH hedging
  const hedge = await HedgingFactory.deploy(DAI_ADDRESS, WETH_ADDRESS, UNISWAP_V2_ROUTER);
  await hedge.waitForDeployment();
  console.log("HedgingModule at:", await hedge.getAddress());

  const MEVFactory = await ethers.getContractFactory("MEVModule");
  const mev = await MEVFactory.deploy(UNISWAP_V2_ROUTER, DAI_ADDRESS);
  await mev.waitForDeployment();
  console.log("MEVModule at:", await mev.getAddress());

  // 2) Deploy Bart9Figures
  const Bart9F = await ethers.getContractFactory("Bart9Figures");
  const flPremium = FLASH_LOAN_PREMIUM ? parseInt(FLASH_LOAN_PREMIUM) : 9;
  const slip = SLIPPAGE_TOLERANCE ? parseInt(SLIPPAGE_TOLERANCE) : 300;

  const bart = await Bart9F.deploy(
    LENDING_POOL,
    UNISWAP_V2_ROUTER,
    SUSHI_ROUTER,
    UNISWAP_V3_ROUTER,
    DAI_ADDRESS,
    flPremium,
    slip,
    CHAINLINK_ORACLE,
    deployer.address
  );
  await bart.waitForDeployment();
  const bartAddress = await bart.getAddress();
  console.log("Bart9Figures deployed at:", bartAddress);

  // 3) Set modules
  await (await bart.setBridgeModule(await bridge.getAddress())).wait();
  await (await bart.setHedgingModule(await hedge.getAddress())).wait();
  await (await bart.setMEVModule(await mev.getAddress())).wait();

  // 4) Optional profit threshold
  if(PROFIT_THRESHOLD) {
    await (await bart.setProfitThreshold(ethers.parseUnits(PROFIT_THRESHOLD, 18))).wait();
    console.log("Profit threshold set to:", PROFIT_THRESHOLD);
  }

  console.log("Bart9Figures Deployment Complete!");
}

main().catch(console.error);
