const { ethers } = require("hardhat");
require('dotenv').config();
const { calculateUniswapV2Output, calculateUniswapV2Input } = require('../utils/arbitrage_utils');

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
        return;
      }
      token0 = token0.toLowerCase();
      token1 = token1.toLowerCase();

      if (![token0, token1].includes(DAI) && ![token0, token1].includes(WETH)) {
        console.log(`Skipping pair ${pairAddress} (no DAI or WETH)`);
        return;
      }
      console.log(`Adding listeners for pair: ${pairAddress} (${token0}/${token1})`);

      pairContract.on("Sync", async (reserve0, reserve1) => {
        const blockNumber = await provider.getBlockNumber();
        if (token0 !== (await pairContract.token0()).toLowerCase()) {
            [reserve0, reserve1] = [reserve1, reserve0];
        }
        pairDataCache[pairAddress.toLowerCase()] = {
            token0,
            token1,
            reserve0,
            reserve1,
            lastUpdateBlock: blockNumber,
            lastChecked: Date.now()
        };
        processSwap(pairAddress, reserve0, reserve1, token0, token1, pairAddress);
      });

      pairContract.on("Swap", async () => {
        // Sync event handles reserve update.
      });

      try {
          const reserves = await pairContract.getReserves();
          const blockNumber = await provider.getBlockNumber();
          const initialToken0 = await pairContract.token0();
          if (token0 !== initialToken0.toLowerCase()) {
              [reserves[0], reserves[1]] = [reserves[1], reserves[0]];
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
        const uniswapFactory = new ethers.Contract(await getFactory(UNISWAP_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);
        const sushiFactory = new ethers.Contract(await getFactory(SUSHI_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);

        const allPairs = Object.keys(pairDataCache);
        const potentialTriangles = findTriangularPairs(token0, token1, allPairs, pairDataCache);

        for (const triangle of potentialTriangles) {
            await checkTriangularArbitrage(triangle, provider);
        }

        let otherRouter;
        let otherFactory;
        if(currentPool.toLowerCase() == UNISWAP_ROUTER.toLowerCase()){
            otherRouter = SUSHI_ROUTER;
            otherFactory = await getFactory(SUSHI_ROUTER, provider);
        } else if (currentPool.toLowerCase() == SUSHI_ROUTER.toLowerCase()){
            otherRouter = UNISWAP_ROUTER;
            otherFactory = await getFactory(UNISWAP_ROUTER, provider);
        } else {
            console.error("Unknown pool");
            return;
        }

        const otherPairAddress = await otherFactory.getPair(token0, token1);
        if(otherPairAddress === ethers.constants.AddressZero) return;
        const otherPairData = pairDataCache[otherPairAddress.toLowerCase()];
        if (!otherPairData) return;

        let daiWethReserve, otherReserve, otherPairDaiWethReserve, otherPairOtherReserve;
        let tradeTokenIn, tradeTokenOut;
        if (token0 === DAI || token0 === WETH) {
            daiWethReserve = reserve0;
            otherReserve = reserve1;
            otherPairDaiWethReserve = otherPairData.reserve0;
            otherPairOtherReserve = otherPairData.reserve1;
            tradeTokenIn = token1;
            tradeTokenOut = token0;
        } else {
            daiWethReserve = reserve1;
            otherReserve = reserve0;
            otherPairDaiWethReserve = otherPairData.reserve1;
            otherPairOtherReserve = otherPairData.reserve0;
            tradeTokenIn = token0;
            tradeTokenOut = token1;
        }
        if (BigInt(daiWethReserve) < BigInt(LIQUIDITY_THRESHOLD) || BigInt(otherPairDaiWethReserve) < BigInt(LIQUIDITY_THRESHOLD)) {
            return;
        }

        for (let percentage = 10; percentage <= 50; percentage += 10) {
            const amountIn = (BigInt(otherReserve) * BigInt(percentage)) / 100n;
            const expectedOutputOther = calculateUniswapV2Output(amountIn, otherReserve, daiWethReserve);
            const inputForExpected = calculateUniswapV2Input(expectedOutputOther, otherPairDaiWethReserve, otherPairOtherReserve);
            let profit = BigInt(amountIn) - inputForExpected;
            if(profit > 0n) {
                const [owner] = await ethers.getSigners();
                const bot = await ethers.getContractAt("MegaFlashBot", process.env.BOT_ADDRESS, owner);
                let estimatedGasCost = 0n;
                try {
                    const gasEstimate = await bot.estimateGas.executeFlashLoan(
                        amountIn.toString(),
                        tradeTokenIn,
                        tradeTokenOut,
                        ethers.constants.AddressZero,
                        0, // arbType 0 for two-token arbitrage
                        process.env.SLIPPAGE_TOLERANCE
                    );
                    estimatedGasCost = gasEstimate.mul(ethers.utils.parseUnits("20", "gwei"));
                } catch(error) {
                    continue;
                }
                if (profit > estimatedGasCost) {
                    const tradeDetails = {
                        router: otherRouter,
                        amountIn: amountIn.toString(),
                        path: [tradeTokenIn, tradeTokenOut],
                        expectedProfit: profit.toString(),
                        arbType: 0
                    };
                    executeArbitrage(provider, bot, tradeDetails, owner).catch(console.error);
                }
            }
        }
    }

    async function checkTriangularArbitrage(triangle, provider) {
        if(!triangle || triangle.length != 3) return;
        const [pair1, pair2, pair3] = triangle;
        const pair1Contract = new ethers.Contract(pair1, require('../abis/IUniswapV2Pair.json'), provider);
        const pair2Contract = new ethers.Contract(pair2, require('../abis/IUniswapV2Pair.json'), provider);
        const pair3Contract = new ethers.Contract(pair3, require('../abis/IUniswapV2Pair.json'), provider);

        let reserves1, reserves2, reserves3;
        try {
            [reserves1, reserves2, reserves3] = await Promise.all([
                pair1Contract.getReserves(),
                pair2Contract.getReserves(),
                pair3Contract.getReserves()
            ]);
        } catch(error) {
            console.log("Error getting reserves on triangle check");
            return;
        }
        if (!reserves1 || !reserves2 || !reserves3) return;

        let tokenA, tokenB, tokenC;
        try {
            [tokenA, tokenB, tokenC] = await Promise.all([
                pair1Contract.token0(),
                pair2Contract.token0(),
                pair3Contract.token0()
            ]);
        } catch(error) {
            console.log("Error getting tokens in triangle check", error);
        }
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
                try {
                    const gasEstimate = await bot.estimateGas.executeFlashLoan(
                        amountIn.toString(),
                        tokenA,
                        tokenB,
                        tokenC,
                        1, // ArbType 1 for THREE_TOKEN
                        process.env.SLIPPAGE_TOLERANCE
                    );
                    estimatedGasCost = gasEstimate.mul(ethers.utils.parseUnits("20", "gwei"));
                } catch(error) {
                    continue;
                }
                if (profit > estimatedGasCost) {
                    const tradeDetails = {
                        router: UNISWAP_ROUTER,
                        amountIn: amountIn.toString(),
                        path: [tokenA, tokenB, tokenC],
                        expectedProfit: profit.toString(),
                        arbType: 1
                    };
                    executeArbitrage(provider, bot, tradeDetails, owner, 1).catch(console.error);
                }
            }
        }
    }

    function findTriangularPairs(token0, token1, allPairs, pairDataCache) {
        const potentialTriangles = [];
        for (const pair of allPairs) {
            const pairData = pairDataCache[pair.toLowerCase()];
            if (!pairData) continue;
            const { token0: p0, token1: p1 } = pairData;
            const sharesToken0 = (p0.toLowerCase() === token0.toLowerCase() || p1.toLowerCase() === token0.toLowerCase());
            const sharesToken1 = (p0.toLowerCase() === token1.toLowerCase() || p1.toLowerCase() === token1.toLowerCase());
            if ((sharesToken0 && !sharesToken1) || (!sharesToken0 && sharesToken1)) {
                const sharedToken = sharesToken0 ? token0 : token1;
                const otherToken = sharesToken0 ? token1 : token0;
                const thirdTokenCandidate = (p0.toLowerCase() === sharedToken.toLowerCase()) ? p1 : p0;
                for (const pair2 of allPairs) {
                    if (pair2.toLowerCase() === pair.toLowerCase()) continue;
                    const pairData2 = pairDataCache[pair2.toLowerCase()];
                    if (!pairData2) continue;
                    const { token0: p2t0, token1: p2t1 } = pairData2;
                    const connectsOther = (p2t0.toLowerCase() === otherToken.toLowerCase() || p2t1.toLowerCase() === otherToken.toLowerCase());
                    const connectsThird = (p2t0.toLowerCase() === thirdTokenCandidate.toLowerCase() || p2t1.toLowerCase() === thirdTokenCandidate.toLowerCase());
                    if (connectsOther && connectsThird) {
                        potentialTriangles.push([pair.toLowerCase(), pair2.toLowerCase(), getPairAddress(sharedToken, thirdTokenCandidate, (sharedToken.toLowerCase() === token0.toLowerCase() || sharedToken.toLowerCase() === token1.toLowerCase()) ? UNISWAP_ROUTER : SUSHI_ROUTER)]);
                    }
                }
            }
        }
        return potentialTriangles;
    }

    function getPairAddress(tokenA, tokenB, router) {
      const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
      const salt = ethers.keccak256(ethers.solidityPacked(['address', 'address'], [token0, token1]));
      let factoryAddress;
      if(router == UNISWAP_ROUTER){
          factoryAddress = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; // Uniswap
      } else {
          factoryAddress = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"; // Sushiswap
      }
      const initCodeHash = "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303";
      const create2Address = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
      return create2Address;
    }

    async function setupInitialPairs(factory, provider) {
        const allPairsLength = await factory.allPairsLength();
        for (let i = 0; i < allPairsLength; i++) {
            try {
                const pairAddress = await factory.allPairs(i);
                await addPairListeners(pairAddress, provider);
            } catch (error) {
                console.log("Error in allPairs loop:", error);
            }
        }
    }

    async function reconnectWebSocket(provider) {
        try {
            console.log("Reconnecting WebSocket...");
            const newProvider = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
            return newProvider;
        } catch (error) {
            console.log("Error reconnecting:", error);
        }
    }

    let ws;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const INITIAL_RECONNECT_DELAY = 1000; // 1 second

    function connect() {
        ws = new WebSocket(process.env.RPC_URL);
        ws.on('open', async () => {
            console.log("WebSocket connected.");
            reconnectAttempts = 0;
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_subscribe",
                params: ["newPendingTransactions"]
            }));
            console.log("Subscribed to pending transactions.");
            const uniswapFactory = new ethers.Contract(await getFactory(UNISWAP_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);
            const sushiFactory = new ethers.Contract(await getFactory(SUSHI_ROUTER, provider), require('../abis/IUniswapV2Factory.json'), provider);
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
            setInterval(async () => {
              for (const pairAddress in pairDataCache) {
                if (pairDataCache.hasOwnProperty(pairAddress)) {
                  const pairData = pairDataCache[pairAddress];
                  if (Date.now() - pairData.lastChecked >= 60000) {
                    try {
                      const pairContract = new ethers.Contract(pairAddress, require('../abis/IUniswapV2Pair.json'), provider);
                      const reserves = await pairContract.getReserves();
                      const blockNumber = await provider.getBlockNumber();
                      const token0 = await pairContract.token0();
                      let reserve0 = reserves[0];
                      let reserve1 = reserves[1];
                      if(pairData.token0.toLowerCase() != token0.toLowerCase()){
                        [reserve0, reserve1] = [reserve1, reserve0];
                      }
                      pairDataCache[pairAddress.toLowerCase()] = {
                          token0: pairData.token0,
                          token1: pairData.token1,
                          reserve0,
                          reserve1,
                          lastUpdateBlock: blockNumber,
                          lastChecked: Date.now()
                      };
                    } catch (error) {
                      console.error(`Error refreshing reserves for pair ${pairAddress}:`, error);
                    }
                  }
                }
              }
            }, 60000);
        });
        ws.on('close', () => {
            console.log("WebSocket connection closed.");
            attemptReconnect();
        });
        ws.on('error', (error) => {
            console.error("WebSocket error:", error);
        });
    }

    function attemptReconnect() {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
            console.log(`Attempting to reconnect (attempt ${reconnectAttempts + 1}) in ${delay / 1000} seconds...`);
            reconnectAttempts++;
            setTimeout(connect, delay);
        } else {
            console.error("Max reconnect attempts reached. Exiting.");
            process.exit(1);
        }
    }
    connect();
}

main().catch(console.error);

