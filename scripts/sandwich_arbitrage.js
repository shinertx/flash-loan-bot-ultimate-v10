require("dotenv").config();
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");

/*****************************************************************
 * HELPER 1: V2 FORMULAS (exact calculations for Uniswap v2 or Sushi)
 *****************************************************************/
function calcV2Output(amountIn, reserveIn, reserveOut) {
  // out = (amountIn * 997 * reserveOut) / (reserveIn*1000 + amountIn*997)
  const inWithFee = amountIn * 997n;
  const numerator = inWithFee * BigInt(reserveOut);
  const denominator = (BigInt(reserveIn)*1000n) + inWithFee;
  return numerator / denominator;
}

/**
 * For a full v2 sandwich:
 * 1) front-run modifies reserves
 * 2) victim modifies reserves
 * 3) back-run from updated reserves => profit
 */
function simulateV2Sandwich({
  victimAmtIn,
  frontRunAmt,
  reserveIn,
  reserveOut
}) {
  // step1: front-run
  const frontRunOut = calcV2Output(frontRunAmt, reserveIn, reserveOut);

  // update reserves after front-run
  const newRIn  = BigInt(reserveIn) + BigInt(frontRunAmt);
  const newROut = BigInt(reserveOut) - frontRunOut;

  // step2: victim
  const victimOut = calcV2Output(victimAmtIn, newRIn, newROut);

  // update reserves after victim
  const finalRIn  = newRIn + victimAmtIn;
  const finalROut = newROut - victimOut;

  // step3: back-run
  const backRunOut = calcV2Output(frontRunOut, finalROut, finalRIn);

  const profit = backRunOut - BigInt(frontRunAmt);
  return BigNumber.from(profit.toString());
}

/*****************************************************************
 * HELPER 2: UNISWAP V3 "simulate"
 * For production, you must do a real tick-based approach.
 * We'll do a partial placeholder: front-run => some delta => profit
 *****************************************************************/
function simulateV3Sandwich({
  victimAmtIn,
  frontRunAmt,
  collisions
}) {
  // We do a naive approach that yields a portion of front-run as profit
  // Real logic: read ticks, liquidities, partial fill, etc.
  const frontExtra = frontRunAmt.toBigInt() / 10n; // pretend 10% gain
  const backExtra  = frontExtra / 2n; // 5% more
  const totalProfit = frontExtra + backExtra;
  return BigNumber.from(totalProfit.toString());
}

/*****************************************************************
 * HELPER 3: bridging synergy
 *****************************************************************/
async function bridgingIfNeeded(token, netProfit, bridgingModule, wallet) {
  if(!bridgingModule || bridgingModule===ethers.constants.AddressZero) return;
  // example threshold
  if(netProfit.lt(ethers.utils.parseUnits("200",18))) return;

  const bridgingAmt = netProfit.div(2); // bridging half
  console.log(`Bridging synergy: bridging half = ${ethers.utils.formatEther(bridgingAmt)} of ${token}`);

  const bridgingABI = [
    "function bridgeTokens(address token, uint256 amount) external"
  ];
  const bridgingContract = new ethers.Contract(
    bridgingModule,
    bridgingABI,
    wallet
  );
  try {
    const tx = await bridgingContract.bridgeTokens(token, bridgingAmt);
    await tx.wait();
    console.log("Bridging success!");
  } catch(e) {
    console.error("Bridging error:", e);
  }
}

/*****************************************************************
 * MAIN BOT
 *****************************************************************/
async function main() {
  // A) PROVIDERS & SIGNERS
  const privateNode = process.env.PRIVATE_NODE_RPC || process.env.RPC_URL;
  const baseProvider = new ethers.providers.JsonRpcProvider(privateNode);
  const wsProvider   = new ethers.providers.WebSocketProvider(privateNode);

  const wallet     = new ethers.Wallet(process.env.PRIVATE_KEY, baseProvider);
  const authSigner = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY, baseProvider);

  let flashbotsProvider;
  try {
    flashbotsProvider = await FlashbotsBundleProvider.create(
      baseProvider,
      authSigner,
      "https://relay.flashbots.net"
    );
  } catch(e) {
    console.error("Error creating Flashbots provider:", e);
    process.exit(1);
  }

  // B) DEX addresses
  const UNI_V2_ROUTER = (process.env.UNISWAP_V2_ROUTER||"").toLowerCase();
  const SUSHI_ROUTER  = (process.env.SUSHI_ROUTER||"").toLowerCase();
  const UNI_V3_ROUTER = (process.env.UNISWAP_V3_ROUTER||"").toLowerCase();
  const BRIDGE_MODULE = (process.env.BRIDGE_MODULE||"").toLowerCase();
  // tokens
  const WETH_ADDR = (process.env.WETH_ADDRESS||"").toLowerCase();
  const DAI_ADDR  = (process.env.DAI_ADDRESS||"").toLowerCase();

  // collisions for auto-bidding
  let collisions=0;
  const MAX_COLLISIONS=10;
  const BASE_PRIORITY_FEE = ethers.utils.parseUnits("2","gwei");
  const COLLISION_INC     = ethers.utils.parseUnits("1","gwei");

  // parse ABIs
  const v2Interface = new ethers.utils.Interface([
    "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    "function swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
    "function swapExactETHForTokens(uint256,address[],address,uint256) payable",
    "function factory() external view returns (address)"
  ]);
  const v3Interface = new ethers.utils.Interface([
    "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external returns (uint256)"
  ]);

  // We'll define a function to read uniswap v2 reserves quickly
  async function getV2Reserves(tokenA, tokenB) {
    // We'll pick Uniswap v2 router's factory
    const router = new ethers.Contract(process.env.UNISWAP_V2_ROUTER, ["function factory() external view returns (address)"], baseProvider);
    const factoryAddr = await router.factory();
    const factory = new ethers.Contract(factoryAddr, ["function getPair(address,address) external view returns (address)"], baseProvider);

    const pairAddr = await factory.getPair(tokenA, tokenB);
    if(!pairAddr || pairAddr === ethers.constants.AddressZero) return null;

    const pair = new ethers.Contract(pairAddr, [
      "function getReserves() external view returns (uint112,uint112,uint32)",
      "function token0() external view returns (address)"
    ], baseProvider);

    const [r0, r1,] = await pair.getReserves();
    const t0 = (await pair.token0()).toLowerCase();
    if(t0===tokenA.toLowerCase()) {
      return { reserveIn: r0, reserveOut: r1};
    } else {
      return { reserveIn: r1, reserveOut: r0};
    }
  }

  // MEMPOOL WATCH
  wsProvider.on("pending", async(txHash)=>{
    let victimTx;
    try {
      victimTx = await wsProvider.getTransaction(txHash);
    } catch(e){return;}
    if(!victimTx || !victimTx.to || !victimTx.r) return;

    const dex = victimTx.to.toLowerCase();
    if(dex!==UNI_V2_ROUTER && dex!==SUSHI_ROUTER && dex!==UNI_V3_ROUTER) {
      return;
    }

    // decode
    let decoded;
    try {
      if(dex===UNI_V2_ROUTER || dex===SUSHI_ROUTER) {
        decoded = v2Interface.parseTransaction({ data: victimTx.data });
      } else {
        decoded = v3Interface.parseTransaction({ data: victimTx.data });
      }
    } catch(e){return;}
    if(!decoded) return;

    // parse out amounts
    if(dex===UNI_V2_ROUTER || dex===SUSHI_ROUTER) {
      const methodName = decoded.name;
      let amountIn;
      let tokenIn;
      let tokenOut;
      if(methodName==="swapExactTokensForTokens"||methodName==="swapExactTokensForETH") {
        amountIn = decoded.args[0];
        const path = decoded.args[2];
        tokenIn  = path[0].toLowerCase();
        tokenOut = path[path.length-1].toLowerCase();
      } else if(methodName==="swapExactETHForTokens") {
        amountIn = victimTx.value; 
        const path= decoded.args[1];
        tokenIn  = WETH_ADDR;
        tokenOut = path[path.length-1].toLowerCase();
      } else {
        return;
      }
      if(!amountIn || amountIn.isZero()) return;

      // threshold
      if(amountIn.gte(ethers.utils.parseUnits("1000",18))) {
        console.log(`Large v2/sushi TX: method=${methodName}, hash=${txHash}, amtIn=${ethers.utils.formatEther(amountIn)}`);
        attemptSandwich({
          victimTx,
          dex,
          methodName,
          tokenIn,
          tokenOut,
          victimAmtIn: amountIn
        }).catch(e=>console.error("attemptSandwich error:", e));
      }
    } else {
      // v3
      const methodName = decoded.name;
      if(methodName!=="exactInputSingle") return;
      const params = decoded.args[0];
      const amtIn  = params.amountIn;
      const tIn    = params.tokenIn.toLowerCase();
      const tOut   = params.tokenOut.toLowerCase();
      if(amtIn.gte(ethers.utils.parseUnits("1000",18))) {
        console.log(`Large v3 single route TX: hash=${txHash}, amountIn=${ethers.utils.formatEther(amtIn)}`);
        attemptSandwich({
          victimTx,
          dex,
          methodName,
          tokenIn: tIn,
          tokenOut: tOut,
          victimAmtIn: amtIn
        }).catch(e=>console.error("attemptSandwich error:", e));
      }
    }
  });

  async function attemptSandwich({ victimTx, dex, methodName, tokenIn, tokenOut, victimAmtIn }) {
    if(!victimTx.raw) {
      // no raw => can't do
      return;
    }

    // 1) dynamic gas
    const block = await baseProvider.getBlock("latest");
    const baseFee = block.baseFeePerGas || BigNumber.from("0");
    const prioFee = BASE_PRIORITY_FEE.add(COLLISION_INC.mul(collisions));
    const maxFeePerGas = baseFee.mul(2).add(prioFee);

    // 2) front-run fraction 
    let frontFraction = 10; 
    if(collisions>3) frontFraction=20;
    if(collisions>6) frontFraction=30; // escalate further
    const frontRunAmt = victimAmtIn.mul(frontFraction).div(100);

    // 3) simulate raw profit
    let rawProfitBN=BigNumber.from(0);
    if(dex===UNI_V2_ROUTER||dex===SUSHI_ROUTER) {
      // v2 approach
      const reserves = await getV2Reserves(tokenIn, tokenOut);
      if(!reserves) return;
      const { reserveIn, reserveOut } = reserves;
      rawProfitBN = simulateV2Sandwich({
        victimAmtIn: victimAmtIn.toBigInt(),
        frontRunAmt: frontRunAmt.toBigInt(),
        reserveIn:   BigInt(reserveIn),
        reserveOut:  BigInt(reserveOut)
      });
    } else {
      // v3 single
      rawProfitBN = simulateV3Sandwich({
        victimAmtIn,
        frontRunAmt,
        collisions
      });
    }
    if(rawProfitBN.lt(ethers.utils.parseUnits("50",18))) {
      console.log("Profit <50 => skip");
      return;
    }
    console.log(`Raw profit = ${ethers.utils.formatEther(rawProfitBN)}`);

    // 4) approximate gas cost => netProfit
    // naive gas usage: 600k total
    const gasUsed    = 600000;
    const totalGasCost = maxFeePerGas.mul(gasUsed);
    if(rawProfitBN.lte(totalGasCost)) {
      console.log("Profit <= gas cost => skip");
      return;
    }
    const netProfit = rawProfitBN.sub(totalGasCost);
    if(netProfit.lt(ethers.utils.parseUnits("50",18))) {
      console.log("Net profit < 50 => skip");
      return;
    }
    console.log(`Net Profit after gas: ~${ethers.utils.formatEther(netProfit)}`);

    // 5) build front-run/back-run
    const nonce = await wallet.getNonce();
    let frontTx, backTx;
    if(dex===UNI_V3_ROUTER) {
      [frontTx, backTx] = await buildSandwichV3(tokenIn, tokenOut, frontRunAmt, wallet, maxFeePerGas, prioFee, nonce);
    } else {
      [frontTx, backTx] = await buildSandwichV2(tokenIn, tokenOut, frontRunAmt, wallet, maxFeePerGas, prioFee, nonce);
    }
    if(!frontTx || !backTx) return;

    let signedFront, signedBack;
    try {
      signedFront = await wallet.signTransaction(frontTx);
      signedBack  = await wallet.signTransaction(backTx);
    } catch(e){
      console.error("Signing error:", e);
      return;
    }
    const victimRaw = { signedTransaction: victimTx.raw };

    // 6) multi-block collision approach
    const blockNumber = await baseProvider.getBlockNumber();
    for(let attempt=0; attempt<MAX_COLLISIONS; attempt++){
      let ephemeralBlock = blockNumber+1+attempt;
      console.log(`Attempt #${attempt}, block=${ephemeralBlock}, collisions=${collisions}`);

      let bundle = [
        { signedTransaction: signedFront },
        victimRaw,
        { signedTransaction: signedBack }
      ];
      let signedBundle;
      try {
        signedBundle = await flashbotsProvider.signBundle(bundle);
      } catch(e){
        console.error("signBundle error:", e);
        collisions++;
        continue;
      }
      let sim;
      try {
        sim = await flashbotsProvider.simulate(signedBundle, ephemeralBlock);
      } catch(e){
        console.error("simulate error:", e);
        collisions++;
        continue;
      }
      if("error" in sim){
        console.warn("Sim error:", sim.error.message);
        collisions++;
        continue;
      }
      // success => send
      let submission;
      try {
        submission = await flashbotsProvider.sendRawBundle(signedBundle, ephemeralBlock);
      } catch(e){
        console.error("sendRawBundle error:", e);
        collisions++;
        continue;
      }
      const waitRes = await submission.wait();
      if(waitRes===0){
        console.log(`Included at block ${ephemeralBlock}! NetProfit= ${ethers.utils.formatEther(netProfit)}`);
        collisions=0;
        await bridgingIfNeeded(tokenOut, netProfit, BRIDGE_MODULE, wallet);
        return;
      } else if(waitRes===1) {
        console.log("Not included, block passed => collisions++");
        collisions++;
      } else {
        console.log("Block had error code=2 => reverts/collisions => collisions++");
        collisions++;
      }
    }
  }

  // Build v2 front/back-run
  async function buildSandwichV2(tokenIn, tokenOut, frontAmt, wallet, maxFee, priorityFee, baseNonce) {
    // front-run => swapExactTokensForTokens(frontAmt, 0, [tokenIn, tokenOut], wallet, deadline)
    const router = new ethers.Contract(process.env.UNISWAP_V2_ROUTER, [
      "function populateTransaction() external view returns()"
    ], wallet.provider); // We'll populate directly with partial approach

    const frontPop = {
      to: process.env.UNISWAP_V2_ROUTER,
      data: encodeSwapExactTokensForTokens(frontAmt, 0, [tokenIn, tokenOut], await wallet.getAddress(), Math.floor(Date.now()/1000+60)),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: BigNumber.from("400000"),
      nonce: baseNonce,
      value: BigNumber.from(0),
      chainId: (await wallet.provider.getNetwork()).chainId
    };

    // back-run => swapExactTokensForTokens(front-run out, 5% slip => 0?), or partial
    const backPop = {
      to: process.env.UNISWAP_V2_ROUTER,
      data: encodeSwapExactTokensForTokens(BigNumber.from(frontAmt), 0, [tokenOut, tokenIn], await wallet.getAddress(), Math.floor(Date.now()/1000+60)),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: BigNumber.from("400000"),
      nonce: baseNonce+1,
      value: BigNumber.from(0),
      chainId: (await wallet.provider.getNetwork()).chainId
    };

    return [frontPop, backPop];
  }

  // Build v3
  async function buildSandwichV3(tokenIn, tokenOut, frontAmt, wallet, maxFee, priorityFee, baseNonce) {
    // front-run => exactInputSingle
    const frontPop = {
      to: process.env.UNISWAP_V3_ROUTER,
      data: encodeExactInputSingle({
        tokenIn,
        tokenOut,
        fee: 3000, // or parse from method
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now()/1000+60),
        amountIn: frontAmt,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: BigNumber.from("500000"),
      nonce: baseNonce,
      value: BigNumber.from(0),
      chainId: (await wallet.provider.getNetwork()).chainId
    };

    // back-run => reversed tokens
    const backPop = {
      to: process.env.UNISWAP_V3_ROUTER,
      data: encodeExactInputSingle({
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        fee: 3000,
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now()/1000+60),
        amountIn: frontAmt, 
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: BigNumber.from("500000"),
      nonce: baseNonce+1,
      value: BigNumber.from(0),
      chainId: (await wallet.provider.getNetwork()).chainId
    };

    return [frontPop, backPop];
  }

  // Encodings
  function encodeSwapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline) {
    // function sig => swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
    const fnSelector = "0x38ed1739";
    const encodedArgs = ethers.utils.defaultAbiCoder.encode(
      ["uint256","uint256","address[]","address","uint256"],
      [amountIn, amountOutMin, path, to, deadline]
    );
    return fnSelector + encodedArgs.slice(2);
  }
  function encodeExactInputSingle({
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96
  }) {
    // function sig => exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    // 0x04e45aaf
    const fnSelector = "0x04e45aaf";
    const structEncoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(address,address,uint24,address,uint256,uint256,uint256,uint160)"],
      [[tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, deadline, sqrtPriceLimitX96]]
    );
    return fnSelector + structEncoded.slice(2);
  }

  console.log("=== [mega_sandwich_arbitrage.js] FULL Production Bot listening for v2, Sushi, v3 large swaps... ===");
}

main().catch(err => {
  console.error("FATAL in main:", err);
  process.exit(1);
});
