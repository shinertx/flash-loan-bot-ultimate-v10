const WebSocket = require('ws');
const { ethers } = require("hardhat");
require('dotenv').config();

const CHAINS = {
  ETH: { ws: 'wss://api.thegraph.com/subgraphs/name/aave/protocol-v2', subgraph: 'aave/protocol-v2' },
  POLY: { ws: 'wss://api.thegraph.com/subgraphs/name/aave/aave-v2-matic', subgraph: 'aave/aave-v2-matic' }
};

async function main() {
  console.log("=== Liquidation Listener: Monitoring for Liquidation Opportunities ===");

  for (const chainKey in CHAINS) {
    const chainData = CHAINS[chainKey];
    const ws = new WebSocket(chainData.ws);

    ws.on('open', () => {
      console.log(`[${chainKey}] Connected to liquidation subgraph.`);
      ws.send(JSON.stringify({
        type: 'start',
        id: '1',
        payload: {
          query: `
          subscription {
            users(where: {healthFactor_lt: "1000000000000000000"}) {
              id
              healthFactor
              borrows { asset { symbol, decimals, id } amount }
              collaterals { asset { symbol, decimals, id } amount }
            }
          }
          `
        }
      }));
    });

    ws.on('message', async (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'data' && parsed.payload.data.users.length > 0) {
          const users = parsed.payload.data.users;
          for (const user of users) {
            console.log(`[${chainKey}] Liquidation opportunity detected for user: ${user.id}`);
            if (parseFloat(user.healthFactor) < 1e18) {
              console.log(`[${chainKey}] User ${user.id} is below health threshold.`);
              // Placeholder: Calculate optimal debt coverage and gas cost.
              // Placeholder: Call the liquidation function on the bot contract.
            } else {
              console.log(`[${chainKey}] User ${user.id} is not eligible for liquidation.`);
            }
          }
        }
      } catch (err) {
        console.error(`[${chainKey}] Error parsing message:`, err);
      }
    });

    ws.on('error', (error) => {
      console.error(`[${chainKey}] WebSocket error:`, error);
      process.exit(1);
    });

    ws.on('close', (code, reason) => {
      console.log(`WebSocket closed for ${chainKey}. Code: ${code}, Reason: ${reason}`);
      reconnectWebSocket(ws, chainData.ws);
    });
  }
}

async function reconnectWebSocket(ws, url) {
  try {
    console.log("Reconnecting WebSocket...");
    const newWs = new WebSocket(url);
    ws = newWs;
  } catch (error) {
    console.log("Error during reconnect:", error);
  }
}

main().catch(console.error);
