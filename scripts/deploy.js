const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
    const {
        LENDING_POOL,
        UNISWAP_V2_ROUTER,
        UNISWAP_V3_ROUTER, // Add V3 Router
        DAI_ADDRESS,
        PROFIT_THRESHOLD,
        SLIPPAGE_TOLERANCE,
        CHAINLINK_ORACLE,
        AXELAR_GATEWAY
    } = process.env;

    const [deployer] = await ethers.getSigners();

    // --- Deploy Modules ---

    // 1. BridgeModule (with Axelar)
    const BridgeModule = await ethers.getContractFactory("BridgeModule");
    const bridgeModule = await BridgeModule.deploy(AXELAR_GATEWAY, DAI_ADDRESS);
    await bridgeModule.waitForDeployment();
    const bridgeModuleAddress = await bridgeModule.getAddress();
    console.log("BridgeModule deployed to:", bridgeModuleAddress);

    // 2. HedgingModule
    const HedgingModule = await ethers.getContractFactory("HedgingModule");
    const hedgingModule = await HedgingModule.deploy(DAI_ADDRESS); //  Pass DAI
    await hedgingModule.waitForDeployment();
    const hedgingModuleAddress = await hedgingModule.getAddress();
    console.log("HedgingModule deployed to:", hedgingModuleAddress);

    // 3. MEVModule
    const MEVModule = await ethers.getContractFactory("MEVModule");
    const mevModule = await MEVModule.deploy(UNISWAP_V2_ROUTER, DAI_ADDRESS);
    await mevModule.waitForDeployment();
    const mevModuleAddress = await mevModule.getAddress();
    console.log("MEVModule deployed to:", mevModuleAddress);

    // --- Deploy Main Contract ---

    // 4. MegaFlashBot
    const MegaFlashBot = await ethers.getContractFactory("MegaFlashBot");
    const bot = await MegaFlashBot.deploy(
        LENDING_POOL,
        DAI_ADDRESS,
        CHAINLINK_ORACLE,
        UNISWAP_V2_ROUTER,
        UNISWAP_V3_ROUTER, // Pass V3 Router
        deployer.address  // Owner
    );

    await bot.waitForDeployment();
    const botAddress = await bot.getAddress();
    console.log("MegaFlashBot deployed to:", botAddress);

    // --- Set Module Addresses in MegaFlashBot ---

    await (await bot.setBridgeModule(bridgeModuleAddress)).wait();
    console.log("BridgeModule set in MegaFlashBot");
    await (await bot.setMEVModule(mevModuleAddress)).wait();
    console.log("MEVModule set in MegaFlashBot");
    await (await bot.setHedgingModule(hedgingModuleAddress)).wait();
    console.log("HedgingModule set in MegaFlashBot");

    console.log("Deployment Complete!");
}

main().catch(console.error);
