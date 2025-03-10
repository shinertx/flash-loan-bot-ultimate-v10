const { ethers } = require("hardhat");
require('dotenv').config();
const { calculateUniswapV2Output, calculateUniswapV2Input} = require('../utils/arbitrage_utils');

async function main() {
    console.log("=== Mempool Listener: Monitoring for Arbitrage Opportunities ===");

    const provider = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
    const { UNISWAP_ROUTER, SUSHI_ROUTER, DAI_ADDRESS, WETH_ADDRESS, LIQUIDITY_THRESHOLD } = process.env;
    const DAI = DAI_ADDRESS.toLowerCase();
    const WETH = WETH_ADDRESS.toLowerCase();
    const pairDataCache = {};

    async function getFactory(routerAddress, provider) {
        const routerContract = new ethers.Contract(routerAddress, ['function factory() external view returns (address)'], provider);
        return await routerContract.factory();
    }

    async function addPairListeners(pairAddress, provider) {
      const pairContract = new ethers.Contract(pairAddress, require('../abis/IUniswapV2Pair.json'), provider);
      let token0, token1;
      try {
        [token0, token1] = await Promise.all([pairContract.token0(), pairContract.token1()]);
      } catch (error) {
        console.error(`Error fetching tokens for pair ${pairAddress}:`, error);
        return; // Don't add listeners if we can't get token info
      }
        token0 = token0.toLowerCase();
        token1 = token1.toLowerCase();

      if (![token0, token1].includes(DAI) && ![token0, token1].includes(WETH)) {
        console.log(`Skipping pair ${pairAddress} (no DAI or WETH)`);
        return;
      }
        console.log(`Adding listeners for pair: <span class="math-inline">\{pairAddress\} \(</span>{token0}/${token1})`);

      // --- Listen for Sync events ---
      pairContract.on("Sync", async (reserve0, reserve1) => {
        // console.log(`Sync event on pair: ${pairAddress}`); //Reduce logging

        const blockNumber = await provider.getBlockNumber();
        // Ensure consistent token order
        if(token0 != (await pairContract.token0()).toLowerCase()){
              [reserve0, reserve1] = [reserve1, reserve0];
        }

        pairDataCache[pairAddress.toLowerCase()] = {
            token0,
            token1,
            reserve0,
            reserve1,
            lastUpdateBlock: blockNumber,
            lastChecked: Date.now() // Add this line
        };
          //Asynchronously check for arbitrage.
          processSwap(pairAddress, reserve0, reserve1, token0, token1, pairContract.address);
      });

      // --- Listen for Swap Events ---
      pairContract.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to) => {
        // console.log(`Swap event on pair: ${pairAddress}`); // Reduce logging for production

        // We don't need to do anything here anymore!  The *Sync* event
        // handler will update the reserves, and *that's* where we check for arbitrage.

        });

      // Initial reserve fetch and cache population
        try {
            const reserves = await pairContract.getReserves();
            const blockNumber = await provider.getBlockNumber();
            // Ensure consistent token order
            const initialToken0 = await pairContract.token0();
            if(token0 != initialToken0.toLowerCase()){
                [reserve0, reserve1] = [reserve1, reserve0];
            }
             pairDataCache[pairAddress.toLowerCase()] = {
                  token0,
                  token1,
                  reserve0: reserves[0],
                  reserve1: reserves[1],
                  lastUpdateBlock: blockNumber,
                  lastChecked: Date.now()
              };

        } catch (error) {
            console.error(`Error fetching initial reserves for pair ${pairAddress}:`, error);
        }
    }

    async function processSwap(pairAddress, reserve0, reserve1, token0, token1, currentPool) {

        // --- (Existing arbitrage calculation logic) ---
        //Find other pairs to create triangle
        //Get router and factory
        const uniswapFactory = new ethers.Contract(await getFactory(UNISWAP_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);
        const sushiFactory = new ethers.Contract(await getFactory(SUSHI_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);

        const allPairs = Object.keys(pairDataCache);
        const potentialTriangles = findTriangularPairs(token0, token1, allPairs, pairDataCache);

            // --- Check for triangular arbitrage ---
        for (const triangle of potentialTriangles) {
            await checkTriangularArbitrage(triangle, provider);
        }
        // --- Existing Two-Token Arbitrage Logic ---
        // ... (Your existing two-token arbitrage logic here, using the cached reserves) ...
        // --- Get other pair address ---
        let otherRouter;
        let otherFactory;
        if(currentPool.toLowerCase() == UNISWAP_ROUTER){
        otherRouter = SUSHI_ROUTER;
        otherFactory = await getFactory(SUSHI_ROUTER, provider);

        }else if (currentPool.toLowerCase() == SUSHI_ROUTER){
            otherRouter = UNISWAP_ROUTER;
            otherFactory = await getFactory(UNISWAP_ROUTER, provider);

        }else{
        console.error("Unkown pool");
        return;
        }

        const otherPairAddress = await otherFactory.getPair(token0, token1);

        if(otherPairAddress === ethers.ZeroAddress) {
        //console.error(`Other pair does not exist for ${token0} and ${token1}`); //Reduce logging
        return;
        }
        //Check for cached
        const otherPairData = pairDataCache[otherPairAddress.toLowerCase()];
        if (!otherPairData) {
        // console.warn(`Reserves not found for other pair: ${otherPairAddress}.  Skipping.`); //Reduce logging
            return;
        }

        // --- Calculate Arbitrage Opportunity ---
        // Determine which token is DAI/WETH, and set up reserves accordingly.
        let daiWethReserve, otherReserve, otherPairDaiWethReserve, otherPairOtherReserve;
        let tradeTokenIn, tradeTokenOut

        if (token0.toLowerCase() === DAI || token0.toLowerCase() === WETH) {
            daiWethReserve = reserve0;
            otherReserve = reserve1;
            otherPairDaiWethReserve = otherPairData.reserve0;
            otherPairOtherReserve = otherPairData.reserve1;
            tradeTokenIn = token1;
            tradeTokenOut = token0
        } else {
            daiWethReserve = reserve1;
            otherReserve = reserve0;
            otherPairDaiWethReserve = otherPairData.reserve1;
            otherPairOtherReserve = otherPairData.reserve0;
            tradeTokenIn = token0;
            tradeTokenOut = token1
        }
              // Check liquidity threshold before proceeding.
        if (BigInt(daiWethReserve) < BigInt(process.env.LIQUIDITY_THRESHOLD) || BigInt(otherPairDaiWethReserve) < BigInt(process.env.LIQUIDITY_THRESHOLD)) {
            //console.log(`Liquidity below threshold for pair: ${pairAddress} or ${otherPairAddress}. Skipping.`);
            return;
        }

        //Iterate over different amounts.
        for (let percentage = 10; percentage <= 50; percentage += 10) { // Check 10% to 50%
            const amountIn = (BigInt(otherReserve) * BigInt(percentage)) / 100n;

            const expectedOutputOther = calculateUniswapV2Output(amountIn, otherReserve, daiWethReserve);
            const inputForExpected = calculateUniswapV2Input(expectedOutputOther, otherPairDaiWethReserve, otherPairOtherReserve);

                let profit = BigInt(amountIn) - inputForExpected;

                if(profit > 0n) { // Check if we have a theoretical profit

                const [owner] = await ethers.getSigners();
                const bot = await ethers.getContractAt("MegaFlashBot", process.env.BOT_ADDRESS, owner);
                let estimatedGasCost = 0n;

                try{
                    //Estimate the gas.
                    const gasEstimate = await bot.estimateGas.executeFlashLoan(
                        amountIn.toString(),
                        tradeTokenIn,
                        tradeTokenOut,
                        ethers.constants.AddressZero,
                        0, // arbType 0 for two-token
                        process.env.SLIPPAGE_TOLERANCE
                    );
                    estimatedGasCost = gasEstimate.mul(ethers.utils.parseUnits("20", "gwei")); // Estimate with a base gas price

                }catch(error){
                    //console.log("Gas estimation Error", error) //Reduce logging.
                    continue; // Skip to next
                }


                if (profit > estimatedGasCost) {

                    const tradeDetails = {
                        router: otherRouter,
                        amountIn: amountIn.toString(),
                        path: [tradeTokenIn, tradeTokenOut],
                        expectedProfit: profit.toString(),
                        arbType: 0, // Add the arbitrage type here.
                    };

                    // console.log("OPPORTUNITY:", tradeDetails); // Keep this log for debugging

                    // Execute the arbitrage (asynchronously)
                    executeArbitrage(provider, bot, tradeDetails, owner).catch(console.error);
                }
            }
        }
    }


    async function checkTriangularArbitrage(triangle, provider) {

        if(!triangle || triangle.length != 3) return;
        const [pair1, pair2, pair3] = triangle;

        //Get all reserves.
        const pair1Contract = new ethers.Contract(pair1, require('../abis/IUniswapV2Pair.json'), provider);
        const pair2Contract = new ethers.Contract(pair2, require('../abis/IUniswapV2Pair.json'), provider);
        const pair3Contract = new ethers.Contract(pair3, require('../abis/IUniswapV2Pair.json'), provider);

        let reserves1, reserves2, reserves3;
        try{
            [reserves1, reserves2, reserves3] = await Promise.all([
                pair1Contract.getReserves(),
                pair2Contract.getReserves(),
                pair3Contract.getReserves()
            ]);
        }catch(error
