const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
  const {
    AAVE_LENDING_POOL,
    DAI_ADDRESS,
    UNISWAP_ROUTER,
    MEV_MODULE,
    BRIDGE_CONTRACT,
    CHAINLINK_ORACLE,
    BAND_ORACLE,
    UMA_ORACLE,
    PROFIT_THRESHOLD
  } = process.env;

  const mevAddr = MEV_MODULE && MEV_MODULE.length > 0 ? MEV_MODULE : ethers.constants.AddressZero;
  const bridgeAddr = BRIDGE_CONTRACT && BRIDGE_CONTRACT.length > 0 ? BRIDGE_CONTRACT : ethers.constants.AddressZero;
  const chainlinkAddr = CHAINLINK_ORACLE && CHAINLINK_ORACLE.length > 0 ? CHAINLINK_ORACLE : ethers.constants.AddressZero;
  const bandAddr = BAND_ORACLE && BAND_ORACLE.length > 0 ? BAND_ORACLE : ethers.constants.AddressZero;
  const umaAddr = UMA_ORACLE && UMA_ORACLE.length > 0 ? UMA_ORACLE : ethers.constants.AddressZero;

  const MegaFlashBot = await ethers.getContractFactory("MegaFlashBot");
  const bot = await MegaFlashBot.deploy(
    AAVE_LENDING_POOL,
    DAI_ADDRESS,
    UNISWAP_ROUTER,
    mevAddr,
    bridgeAddr,
    chainlinkAddr,
    bandAddr,
    umaAddr,
    PROFIT_THRESHOLD
  );
  await bot.deployed();
  console.log("MegaFlashBot deployed at:", bot.address);
}

main().catch(console.error);

