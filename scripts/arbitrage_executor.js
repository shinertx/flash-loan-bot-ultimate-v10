const { ethers } = require("hardhat");
require('dotenv').config();
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");
const axios = require('axios');

async function executeArbitrage(provider, bot, tradeDetails, owner, arbType = 0) {
    console.log("Executing Arbitrage...");
    const { FLASHBOTS_AUTH_KEY, SLIPPAGE_TOLERANCE } = process.env;
    const authSigner = new ethers.Wallet(FLASHBOTS_AUTH_KEY, provider);
    if (!FLASHBOTS_AUTH_KEY) {
        console.log("No Flashbots auth key. Skipping submission.");
        return;
    }
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, "https://relay.flashbots.net");

    const routerABI = require('../abis/IUniswapV2Router02.json');
    const router = new ethers.Contract(tradeDetails.router, routerABI, owner);

    const flashloanAmount = tradeDetails.amountIn;
    const token0 = tradeDetails.path[0];
    const token1 = tradeDetails.path[1];
    const token2 = tradeDetails.path.length > 2 ? tradeDetails.path[2] : ethers.constants.AddressZero;

    const flashLoanTx = await bot.populateTransaction.executeFlashLoan(
        flashloanAmount,
        token0,
        token1,
        token2,
        arbType,
        SLIPPAGE_TOLERANCE
    );

    let blockNumber = await provider.getBlockNumber();
    let targetBlockNumber = blockNumber + 1;
    const bundle = [{ signer: owner, transaction: flashLoanTx }];

    let signedBundle;
    try {
        signedBundle = await flashbotsProvider.signBundle(bundle);
    } catch (error){
        console.log("Error signing bundle", error);
    }

    let simulation;
    try {
        simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber);
        if ("error" in simulation) {
            console.warn(`Bundle Simulation Error: ${simulation.error.message}`);
            return;
        }
        console.log(`Simulation Success! Estimated gas: ${simulation.totalGasUsed}`);
        } catch (error) {
        console.error("Simulation error:", error);
        return; // Exit if simulation fails
    }
    console.log(`Submitting bundle for block: ${targetBlockNumber}`);
    try {
        const submission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlockNumber);
        console.log('Bundle submitted to Flashbots! Bundle Hash:', submission.bundleHash);

    } catch (error) {
        console.log("Error submitting to flashbots", error);
    }

    //Multi stage Bidding
    const MAX_BLOCKS = 5;  // Maximum number of blocks to try
     for (let i = 1; i < MAX_BLOCKS; i++) {
        const newTargetBlock = blockNumber + 1 + i;
        console.log(`Submitting bundle, attempt ${i+1}, target block ${newTargetBlock}`);
        try {
              const resubmission = await flashbotsProvider.sendRawBundle(
                signedBundle,
                newTargetBlock
            );
            console.log("Bundle resubmitted! Bundle Hash:", resubmission.bundleHash);

        } catch (error) {
            console.log("Error submitting to flashbots", error);
        }

    }
}

module.exports = { executeArbitrage };
