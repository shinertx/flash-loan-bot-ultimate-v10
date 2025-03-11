// scripts/sandwich_arbitrage.js
require('dotenv').config();
const { ethers } = require("hardhat");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const authSigner = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY, provider);
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner);

    const [owner] = await ethers.getSigners();

    const router = new ethers.Contract(process.env.UNISWAP_V2_ROUTER, [
        'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
        'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
    ], provider);

    const DAI = process.env.DAI_ADDRESS;
    const WETH = process.env.WETH_ADDRESS;
    const MEV_MODULE_ADDRESS = process.env.MEV_MODULE_ADDRESS; // Get this from your deployment
    const mevModule = new ethers.Contract(MEV_MODULE_ADDRESS, [
        'function prepareSandwichAttack(address pair, uint256 frontRunAmount, uint256 backRunAmount, bytes calldata frontRunData, bytes calldata victimTransaction, bytes calldata backRunData) external returns (bytes[] memory)',
        'function encodeUniswapV2Swap(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external pure returns (bytes memory)'
    ], owner); // Use owner as the signer

    //  Listen for pending transactions.
    provider.on("pending", async (txHash) => {
        try {
            const tx = await provider.getTransaction(txHash);
            if (!tx || !tx.to) return;

            //  Target large Uniswap V2 swaps.
            if (tx.to.toLowerCase() === process.env.UNISWAP_V2_ROUTER.toLowerCase()) {
                // Decode the transaction data.
                let decoded;
                try{
                    decoded = router.interface.parseTransaction(tx);
                } catch (error){
                    return; // Not a uniswap v2 transaction.
                }


                if (decoded.name === "swapExactTokensForTokens" || decoded.name === "swapTokensForExactTokens") {
                    const path = decoded.args.path;
                    const amountIn = decoded.args.amountIn;
                    const amountOutMin = decoded.args.amountOutMin;
                    const to = decoded.args.to;

                    //  Check if it's a swap involving DAI and WETH, and that it is large enough.
                    if ((path[0].toLowerCase() === DAI.toLowerCase() && path[path.length - 1].toLowerCase() === WETH.toLowerCase()) ||
                        (path[0].toLowerCase() === WETH.toLowerCase() && path[path.length - 1].toLowerCase() === DAI.toLowerCase())
                    ) {

                         if (amountIn > ethers.parseUnits("1000", 18)) { // Example: Target swaps > 1000 DAI
                            console.log(`Potentially profitable sandwich opportunity detected! Tx Hash: ${txHash}`);

                            // 1. Calculate Front-Run Amount (Example: 90% of the victim's amountIn)
                            const frontRunAmount = amountIn * BigInt(90) / BigInt(100);

                            // 2. Calculate Expected Output of front-run (using getAmountsOut - for simulation ONLY)
                            const amountsOut = await router.getAmountsOut(frontRunAmount, path);
                            const amountOut = amountsOut[1];

                            // 3. Calculate Back-Run Amount (Example: all of the output from the front-run)
                            const backRunAmount = amountOut;

                            // 4. Calculate minimum output for backrun (slippage)
                            const backRunAmountsOut = await router.getAmountsOut(backRunAmount, [path[1], path[0]]); //Reverse path
                            const backRunAmountOutMin = backRunAmountsOut[1] * BigInt(97) / BigInt(100); // Example 3% slippage.

                            // 5. Encode Front-Run Transaction Data
                            const frontRunPath = path;
                            const frontRunDeadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

                            const frontRunData = await mevModule.encodeUniswapV2Swap(
                                frontRunAmount,
                                0, // amountOutMin, setting to zero for the frontrun for simplicity.
                                frontRunPath,
                                MEV_MODULE_ADDRESS, // Send tokens to MEVModule
                                frontRunDeadline
                            );


                            // 6. Encode Back-Run Transaction Data
                            const backRunPath = [path[path.length-1], path[0]];
                            const backRunDeadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes
                            const backRunData = await mevModule.encodeUniswapV2Swap(
                                backRunAmount,
                                backRunAmountOutMin, // Use calculated min amount with slippage.
                                backRunPath,
                                MEV_MODULE_ADDRESS, // Send tokens to MEVModule
                                backRunDeadline
                            );

                            // 7. Prepare the bundle via MEVModule
                            const bundle = await mevModule.prepareSandwichAttack(
                                path[0], // Doesn't really matter.  Could be path[0] or path[1].
                                frontRunAmount,
                                backRunAmount,
                                frontRunData,
                                tx.data, // Include the *raw* victim transaction data.
                                backRunData
                            );


                            // 8. Create Flashbots Bundle Transactions

                            const signedBundle = await flashbotsProvider.signBundle(
                                bundle.map( (txn) => {
                                    return {
                                        signedTransaction: txn
                                    }
                                })
                            );


                            // 9. Simulate the bundle.
                            const blockNumber = await provider.getBlockNumber();
                            const targetBlock = blockNumber + 1;

                            try {

                              const simulation = await flashbotsProvider.simulate(signedBundle, targetBlock);

                               if ('error' in simulation) {
                                  console.warn(`Simulation Error: ${simulation.error.message}`);

                               } else {
                                   console.log(`Simulation Success!`);
                                   // 10. Send the bundle to Flashbots.
                                  const bundleSubmission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);
                                  console.log('Bundle submitted: ', bundleSubmission);
                                  const waitResponse = await bundleSubmission.wait();
                                  console.log(`Wait Response: ${waitResponse}`); // 0=Included, 1=Failed, 2=Failed
                               }


                            } catch(error){
                                console.log("Error:", error)
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error processing transaction:", error);
        }
    });
}

main().catch(console.error);
