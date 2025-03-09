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
    } catch(error) {
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
        if (simulation.results && simulation.results.some(res => res.revert)) {
            console.error("Simulation Reverted:", simulation);
            return;
        }
    } catch (simulationError) {
        console.error("Flashbots Simulation Error:", simulationError);
        return;
    }

    let currentAttempt = 0;
    const initialTimestamp = Date.now();

    let maxFeePerGas, maxPriorityFeePerGas;
    try {
        const gasPriceResponse = await axios.get(process.env.GAS_ORACLE_URL, {
            headers: { 'Authorization': `Bearer ${process.env.BLOCKNATIVE_API_KEY}` }
        });
        maxFeePerGas = ethers.parseUnits(gasPriceResponse.data.fast.maxFeePerGas, 'gwei');
        maxPriorityFeePerGas = ethers.utils.parseUnits(gasPriceResponse.data.fast.maxPriorityFeePerGas, 'gwei');
    } catch (error) {
        console.warn("Gas oracle failed, using provider.getGasPrice():", error);
        maxFeePerGas = await provider.getGasPrice();
        maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");
    }

    while (currentAttempt < parseInt(process.env.MAX_BIDDING_ATTEMPTS)) {
        const timeElapsed = (Date.now() - initialTimestamp) / 1000;
        const bidIncrement = maxPriorityFeePerGas.mul(ethers.parseUnits(process.env.BIDDING_INCREMENT_PERCENTAGE, "gwei")).div(100);
        const timeDecay = Math.max(0, 1 - (timeElapsed / parseInt(process.env.BID_TIME_DECAY_INTERVAL)) * parseFloat(process.env.BID_TIME_DECAY_FACTOR));
        maxPriorityFeePerGas = maxPriorityFeePerGas.add(bidIncrement).mul(ethers.BigNumber.from(Math.floor(timeDecay * 100))).div(100);
        console.log(`Attempt ${currentAttempt + 1}: Max Fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')}, Priority Fee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')}`);

        const newFlashLoanTx = await bot.populateTransaction.executeFlashLoan(
            flashloanAmount,
            token0,
            token1,
            token2,
            arbType,
            SLIPPAGE_TOLERANCE,
            { maxFeePerGas, maxPriorityFeePerGas, gasLimit: simulation.totalGasUsed }
        );

        const newBundle = [{ signer: owner, transaction: newFlashLoanTx }];
        const newSignedBundle = await flashbotsProvider.signBundle(newBundle);
        const newSimulation = await flashbotsProvider.simulate(newSignedBundle, targetBlockNumber);
        if ('error' in newSimulation) {
            console.warn(`Attempt ${currentAttempt + 1} Simulation Error: ${newSimulation.error.message}`);
            break;
        }
        if (newSimulation.results && newSimulation.results.some(res => res.revert)) {
            console.error("Simulation Reverted:", newSimulation);
            return;
        }
        const gasCost = newSimulation.totalGasUsed.mul(maxFeePerGas);
        const expectedProfit = ethers.BigNumber.from(tradeDetails.expectedProfit);
        console.log(`Gas Cost: ${ethers.formatEther(gasCost)}, Expected Profit: ${ethers.formatEther(expectedProfit)}`);

        if (expectedProfit.gt(gasCost)) {
            console.log(`Attempt ${currentAttempt + 1}: Profitable! Submitting...`);
            try {
                const bundleSubmission = await flashbotsProvider.sendRawBundle(newSignedBundle, targetBlockNumber);
                if ('error' in bundleSubmission) throw new Error(bundleSubmission.error.message);
                const waitResponse = await bundleSubmission.wait();
                console.log(`Bundle wait response: ${waitResponse}`);
                if (waitResponse === 0) {
                    console.log("Transaction included in block:", targetBlockNumber);
                    return;
                } else {
                    console.log(`Transaction not included in block: ${waitResponse}`);
                }
            } catch (submissionError) {
                console.error(`Attempt ${currentAttempt + 1} Submission Error:`, submissionError);
            }
        } else {
            console.log(`Attempt ${currentAttempt + 1}: Not profitable. Aborting.`);
            break;
        }
        currentAttempt++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log("Arbitrage execution attempts finished.");
}

module.exports = { executeArbitrage };

