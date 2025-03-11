const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
    const {
        LENDING_POOL,
        UNISWAP_ROUTER,
        DAI_ADDRESS,
        PROFIT_THRESHOLD,
        SLIPPAGE_TOLERANCE,
        CHAINLINK_ORACLE,
        AXELAR_GATEWAY
    } = process.env;

    const [deployer] = await ethers.getSigners();


    // Deploy BridgeModule (if needed)
    const BridgeModule = await ethers.getContractFactory("BridgeModule");
    const bridgeModule = await BridgeModule.deploy(AXELAR_GATEWAY, DAI_ADDRESS);
    await bridgeModule.waitForDeployment();
    const bridgeModuleAddress = await bridgeModule.getAddress();
    console.log("BridgeModule deployed to:", bridgeModuleAddress);

     // Deploy HedgingModule (if needed)
    const HedgingModule = await ethers.getContractFactory("HedgingModule");
    const hedgingModule = await HedgingModule.deploy(DAI_ADDRESS);
    await hedgingModule.waitForDeployment();
    const hedgingModuleAddress = await hedgingModule.getAddress();
    console.log("HedgingModule deployed to:", hedgingModuleAddress);


    // Deploy MEVModule (if needed)
    const MEVModule = await ethers.getContractFactory("MEVModule");
    const mevModule = await MEVModule.deploy(UNISWAP_ROUTER, DAI_ADDRESS);
    await mevModule.waitForDeployment();
    const mevModuleAddress = await mevModule.getAddress();
    console.log("MEVModule deployed to:", mevModuleAddress);


    // Deploy MegaFlashBot
    const MegaFlashBot = await ethers.getContractFactory("MegaFlashBot");
    const bot = await MegaFlashBot.deploy(
        LENDING_POOL,
        UNISWAP_ROUTER,
        DAI_ADDRESS,
        PROFIT_THRESHOLD,
        SLIPPAGE_TOLERANCE,
        CHAINLINK_ORACLE,
        deployer.address //owner
    );

    await bot.waitForDeployment();
    const botAddress = await bot.getAddress();
    console.log("MegaFlashBot deployed to:", botAddress);


    // Set module addresses in MegaFlashBot (if needed)
    if (bridgeModuleAddress) {
        const tx1 = await bot.setBridgeModule(bridgeModuleAddress);
        await tx1.wait();
        console.log("BridgeModule address set in MegaFlashBot");
    }
    if (mevModuleAddress) {
        const tx2 = await bot.setMEVModule(mevModuleAddress);
        await tx2.wait();
        console.log("MEVModule address set in MegaFlashBot");
    }

    if(hedgingModuleAddress){
        const tx3 = await bot.setHedgingModule(hedgingModuleAddress);
        await tx3.wait();
        console.log("HedgingModule address set in MegaFlashBot");
    }
}

main().catch(console.error);
