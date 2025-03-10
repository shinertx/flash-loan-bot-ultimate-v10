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
        }catch(error){
            console.log("Error getting reserves on triangle check")
            return
        }

        // Check if any reserve is null or zero.
        if (!reserves1 || !reserves2 || !reserves3) {
            return;
        }

        // Extract token addresses
        let tokenA, tokenB, tokenC
        try{
            [tokenA, tokenB, tokenC] = await Promise.all([
                pair1Contract.token0(),
                pair2Contract.token0(),
                pair3Contract.token0()
            ]);
        }catch(error){
            console.log("Error getting token in triangle check", error);
        }

        //Ensure consistent ordering of tokens.
        const pairData1 = pairDataCache[pair1.toLowerCase()];
        if(tokenA.toLowerCase() != pairData1.token0.toLowerCase()){
            let temp = reserves1[0];
            reserves1[0] = reserves1[1];
            reserves1[1] = temp;
        }
        const pairData2 = pairDataCache[pair2.toLowerCase()];
        if(tokenB.toLowerCase() != pairData2.token0.toLowerCase()){
            let temp = reserves2[0];
            reserves2[0] = reserves2[1];
            reserves2[1] = temp;
        }
        const pairData3 = pairDataCache[pair3.toLowerCase()];
        if(tokenC.toLowerCase() != pairData3.token0.toLowerCase()){
            let temp = reserves3[0];
            reserves3[0] = reserves3[1];
            reserves3[1] = temp;
        }


        const reserveInA = reserves1[0];
        const reserveOutA = reserves1[1];

        const reserveInB = reserves2[0];
        const reserveOutB = reserves2[1];

        const reserveInC = reserves3[0];
        const reserveOutC = reserves3[1];

        // Now we have a potential triangle: tokenA -> tokenB -> tokenC -> tokenA.
        // Iterate over different amounts to find optimal trade.

        for (let percentage = 10; percentage <= 50; percentage += 10) {
            const amountIn = (BigInt(reserveInA) * BigInt(percentage)) / 100n;

            let amountOutB = calculateUniswapV2Output(amountIn, reserveInA, reserveOutA);
            let amountOutC = calculateUniswapV2Output(amountOutB, reserveInB, reserveOutB);
            let finalAmountA = calculateUniswapV2Output(amountOutC, reserveInC, reserveOutC);

            let profit = finalAmountA - amountIn;

            if (profit > 0n) {
                const [owner] = await ethers.getSigners();
                const bot = await ethers.getContractAt("MegaFlashBot", process.env.BOT_ADDRESS, owner);
                 let estimatedGasCost = 0n;
                // Estimate gas cost (this is a rough estimate and needs refinement)
                try {

                     const gasEstimate = await bot.estimateGas.executeFlashLoan(
                        amountIn.toString(),
                        tokenA, //token0
                        tokenB, //token1
                        tokenC, //token2,
                        1, //ArbitrageType is 1 for THREE_TOKEN
                        process.env.SLIPPAGE_TOLERANCE //Slippage
                    );

                    estimatedGasCost = gasEstimate.mul(ethers.utils.parseUnits("20", "gwei")); // Estimate with a base gas price

                } catch (error) {
                    // console.error("Gas estimation error:", error); //Reduce logging
                    continue; // Skip to next percentage if gas estimation fails
                }

                // Check if profit exceeds estimated gas cost
                if (profit > estimatedGasCost) {
                    const tradeDetails = {
                        router: UNISWAP_ROUTER,  // Assuming Uniswap for triangular
                        amountIn: amountIn.toString(),
                        path: [tokenA, tokenB, tokenC],
                        expectedProfit: profit.toString(),
                        arbType: 1, // Triangular
                    };

                    // console.log("TRIANGULAR OPPORTUNITY:", tradeDetails); // Keep this log

                    // Execute triangular arbitrage (asynchronously)
                    executeArbitrage(provider, bot, tradeDetails, owner, 1).catch(console.error); // 1 for Triangle
                }
            }
        }
    }


    function findTriangularPairs(token0, token1, allPairs, pairDataCache) {
        const potentialTriangles = [];

        // Find pairs that share one token with the original pair
        for (const pair of allPairs) {
            const pairData = pairDataCache[pair.toLowerCase()];
            if (!pairData) continue; // Skip if no data

            const { token0: p0, token1: p1 } = pairData;

            // Check if this pair shares exactly one token with the original pair
            const sharesToken0 = (p0.toLowerCase() === token0.toLowerCase() || p1.toLowerCase() === token0.toLowerCase());
            const sharesToken1 = (p0.toLowerCase() === token1.toLowerCase() || p1.toLowerCase() === token1.toLowerCase());

            if ((sharesToken0 && !sharesToken1) || (!sharesToken0 && sharesToken1)) {
                // Find a third pair that completes the triangle
                const sharedToken = sharesToken0 ? token0 : token1;
                const otherToken = sharesToken0 ? token1 : token0;
                const thirdTokenCandidate = (p0.toLowerCase() === sharedToken.toLowerCase()) ? p1 : p0;

                for (const pair2 of allPairs) {
                    if (pair2.toLowerCase() === pair.toLowerCase()) continue; // Skip the second pair itself
                    const pairData2 = pairDataCache[pair2.toLowerCase()];
                    if (!pairData2) continue;

                    const { token0: p2t0, token1: p2t1 } = pairData2;

                    // Check if the third pair connects the otherToken and thirdTokenCandidate
                    const connectsOther = (p2t0.toLowerCase() === otherToken.toLowerCase() || p2t1.toLowerCase() === otherToken.toLowerCase());
                    const connectsThird = (p2t0.toLowerCase() === thirdTokenCandidate.toLowerCase() || p2t1.toLowerCase() === thirdTokenCandidate.toLowerCase());

                    if (connectsOther && connectsThird) {
                        // We have a potential triangle!  Add it to the list.
                        potentialTriangles.push([pair.toLowerCase(), pair2.toLowerCase(), getPairAddress(sharedToken, thirdTokenCandidate, (sharedToken.toLowerCase() == token0.toLowerCase() || sharedToken.toLowerCase() == token1.toLowerCase()) ? UNISWAP_ROUTER : SUSHI_ROUTER)]);
                    }
                }
            }
        }
        return potentialTriangles;
    }

    //Helper to get a pair address.
    function getPairAddress(tokenA, tokenB, router) {

      const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
      const salt = ethers.keccak256(ethers.solidityPacked(['address', 'address'], [token0, token1]));
      let factoryAddress;

      if(router == UNISWAP_ROUTER){
          factoryAddress = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; //Uniswap
      }else{
         factoryAddress = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"; //Sushi
      }

      const initCodeHash = "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303" //Same for uniswap and sushiswap;
      const create2Address = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
      return create2Address;
    }

    async function setupInitialPairs(factory, provider) {
        const allPairsLength = await factory.allPairsLength();

        for (let i = 0; i < allPairsLength; i++) {
            try{
                const pairAddress = await factory.allPairs(i);
                await addPairListeners(pairAddress, provider);
            }catch(error){
                console.log("Error in allPairsLength loop", error)
            }
        }
    }

    async function reconnectWebSocket(provider){
        try{
            console.log("Reconnecting....")
           const newProvider =  new ethers.providers.WebSocketProvider(process.env.RPC_URL);
           provider = newProvider;
        }catch(error){
            console.log("Error during reconnect", error);
        }
    }

    // --- WebSocket Setup and Connection Logic ---
    let ws;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const INITIAL_RECONNECT_DELAY = 1000; // 1 second

     function connect() {
        ws = new WebSocket(process.env.RPC_URL);

        ws.on('open', async () => {
            console.log("WebSocket connected.");
            reconnectAttempts = 0; // Reset on successful connection

            //Subscribe
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_subscribe",
                params: ["newPendingTransactions"]
            }));
            console.log("Subscribed to pending transactions.");

            const uniswapFactory = new ethers.Contract(await getFactory(UNISWAP_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);
              const sushiFactory = new ethers.Contract(await getFactory(SUSHI_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);

              // Listen for PairCreated (for new pairs)
            uniswapFactory.on("PairCreated", (token0, token1, pairAddress) => {
                console.log(`New Uniswap Pair Created: ${token0} / ${token1} at ${pairAddress}`);
                addPairListeners(pairAddress, provider);
            });
            sushiFactory.on("PairCreated", (token0, token1, pairAddress) => {
                console.log(`New Sushiswap Pair Created: ${token0} / ${token1} at ${pairAddress}`);
                addPairListeners(pairAddress, provider);
            });

            await setupInitialPairs(uniswapFactory, provider);
            await setupInitialPairs(sushiFactory, provider);


            // Periodic Cache Refresh (Fallback)  Moved inside to be apart of the connect.
            setInterval(async () => {
              for (const pairAddress in pairDataCache) {
                if (pairDataCache.hasOwnProperty(pairAddress)) {
                  const pairData = pairDataCache[pairAddress];

                  // Check if 60 seconds have passed since the last check
                    if (Date.now() - pairData.lastChecked >= 60000) { // 60 seconds
                        try {
                            const pairContract = new ethers.Contract(pairAddress, require('../abis/IUniswapV2Pair.json'), provider);
                            const reserves = await pairContract.getReserves();
                            const blockNumber = await provider.getBlockNumber();
                            const token0 = await pairContract.token0();
                            let reserve0 = reserves[0];
                            let reserve1 = reserves[1];
                             // Ensure consistent token order
                            if(pairData.token0.toLowerCase() != token0.toLowerCase()){
                                [reserve0, reserve1] = [reserve1, reserve0];
                            }
                             pairDataCache[pairAddress.toLowerCase()] = {
                                  token0: pairData.token0,
                                  token1: pairData.token1,
                                  reserve0,
                                  reserve1,
                                  lastUpdateBlock: blockNumber,
                                  lastChecked: Date.now()  // Update the lastChecked timestamp
                              };

                            //console.log(`Refreshed reserves for pair: ${pairAddress}`); // Reduce logging.
                        } catch (error) {
                            console.error(`Error refreshing reserves for pair ${pairAddress}:`, error);
                        }
                    }
                }
              }
            }, 60000); // Check every 60 seconds

        });

        ws.on('close', () => {
            console.log("WebSocket connection closed.");
            attemptReconnect();
        });

        ws.on('error', (error) => {
            console.error("WebSocket error:", error);
            // No need to explicitly close; 'close' event will trigger.
        });
    }

    function attemptReconnect() {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
            console.log(`Attempting to reconnect (attempt ${reconnectAttempts + 1}) in ${delay / 1000} seconds...`);
            reconnectAttempts++;
            setTimeout(connect, delay);
        } else {
            console.error("Max reconnect attempts reached.  Exiting.");
            process.exit(1); // Exit (consider a more graceful shutdown).
        }
    }
    connect();
}

main().catch(console.error);
