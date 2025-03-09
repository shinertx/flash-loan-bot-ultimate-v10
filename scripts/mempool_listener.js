setInterval(async () => {
    for (const pairAddress in pairDataCache) {
        if (pairDataCache.hasOwnProperty(pairAddress)) {
            const pairData = pairDataCache[pairAddress];
            if (Date.now() - pairData.lastChecked >= 15000) { // Reduced to 15 seconds
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
}, 15000); // Reduced to 15 seconds
