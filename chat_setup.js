const fs = require('fs');
const readline = require('readline');

(async function main() {
  console.log("Welcome to Flash-Loan-Bot-Ultimate-v10 Setup.\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function ask(q) { return new Promise(res => rl.question(q, ans => res(ans))); }

  let envContent = fs.readFileSync('.env.example', 'utf8');
  
  const rpcUrl = await ask("Enter your mainnet RPC URL: ");
  envContent = envContent.replace("https://mainnet.infura.io/v3/YOUR_INFURA_KEY", rpcUrl);

  const privKey = await ask("Enter your wallet private key: ");
  envContent = envContent.replace("0xYOURPRIVATEKEY", privKey);

  const fbKey = await ask("Enter your FLASHBOTS_AUTH_KEY (or press enter if none): ");
  envContent = envContent.replace("FLASHBOTS_AUTH_KEY=\"\"", `FLASHBOTS_AUTH_KEY="${fbKey}"`);

  const testModeResp = await ask("Enable test mode? (y/n): ");
  if (testModeResp.toLowerCase().startsWith('y')) {
    envContent = envContent.replace("TEST_MODE=\"true\"", "TEST_MODE=\"true\"");
  } else {
    envContent = envContent.replace("TEST_MODE=\"true\"", "TEST_MODE=\"false\"");
  }

  fs.writeFileSync('.env', envContent, 'utf8');
  console.log("\nSetup complete. .env created.\n");
  rl.close();
})();

