const fs = require('fs');
const readline = require('readline');

(async function main() {
  console.log("Welcome to Flash-Loan-Bot-Ultimate-v10 Setup.\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function ask(q) { return new Promise(res => rl.question(q, ans => res(ans))); }

  let envContent = fs.readFileSync('.env.example', 'utf8');

  const rpcUrl = await ask("Enter your Ethereum Node WebSocket URL: ");
  envContent = envContent.replace("wss://YOUR_ETHEREUM_NODE_WEBSOCKET_URL", rpcUrl);

  const privKey = await ask("Enter your wallet private key: ");
  envContent = envContent.replace("YOUR_PRIVATE_KEY", privKey);

  const fbKey = await ask("Enter your FLASHBOTS_AUTH_KEY (or press enter if none): ");
  envContent = envContent.replace("YOUR_FLASHBOTS_AUTH_KEY", fbKey);

  const profitThreshold = await ask("Enter your desired profit threshold (in wei): ");
  envContent = envContent.replace('PROFIT_THRESHOLD="100"', `PROFIT_THRESHOLD="${profitThreshold}"`);

  const testModeResp = await ask("Enable test mode? (y/n): ");
  if (testModeResp.toLowerCase().startsWith('y')) {
    envContent = envContent.replace('TEST_MODE="false"', 'TEST_MODE="true"');
    console.warn("\nTEST MODE ENABLED: Ensure you're using a test network!\n");
  } else {
    envContent = envContent.replace('TEST_MODE="true"', 'TEST_MODE="false"');
  }

  fs.writeFileSync('.env', envContent, 'utf8');
  console.log("\nSetup complete. .env created.\n");
  rl.close();
})();
