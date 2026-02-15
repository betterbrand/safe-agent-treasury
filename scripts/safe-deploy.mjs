#!/usr/bin/env node
/**
 * safe-deploy.mjs — Deploy a Safe smart account on Base
 *
 * Creates a 1-of-2 Safe with two owners:
 *   1. Owner's personal wallet (passed via --owner or SAFE_OWNER env var)
 *   2. Agent hot wallet (retrieved from macOS Keychain)
 *
 * Initial threshold is 1 so either owner can execute during setup.
 * Raise to 2 after configuration is complete (Step 4).
 *
 * Usage:
 *   node scripts/safe-deploy.mjs --owner 0xOwnerAddress
 *   node scripts/safe-deploy.mjs --owner 0xOwnerAddress --threshold 2
 *   node scripts/safe-deploy.mjs --owner 0xOwnerAddress --agent 0xAgentAddress --dry-run
 *   # --agent bypasses Keychain lookup (dry-run only, for testing on dev machines)
 *
 * After deployment, add SAFE_ADDRESS to ~/morpheus/.env
 *
 * Safe v1.4.1 canonical contracts on Base (8453):
 *   ProxyFactory:    0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
 *   SafeL2:          0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
 *   FallbackHandler: 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseAbi,
  encodeFunctionData,
  getAddress,
  zeroAddress,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// --- Load .env ---
const SAFE_DIR = process.env.SAFE_DIR || process.env.MORPHEUS_DIR || `${process.env.HOME}/morpheus`;

function loadEnv(filepath) {
  try {
    const content = readFileSync(filepath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      let value = trimmed.slice(eqIdx + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional
  }
}

loadEnv(`${SAFE_DIR}/.env`);

// --- CLI args ---
const { values: args } = parseArgs({
  options: {
    owner: { type: "string" },
    agent: { type: "string" },
    threshold: { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
    "salt-nonce": { type: "string" },
  },
});

// --- Configuration ---
const RPC_URL =
  process.env.SAFE_RPC || process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";

const KEYCHAIN_ACCOUNT =
  process.env.SAFE_KEYCHAIN_ACCOUNT || process.env.EVERCLAW_KEYCHAIN_ACCOUNT || "everclaw-agent";
const KEYCHAIN_SERVICE =
  process.env.SAFE_KEYCHAIN_SERVICE || process.env.EVERCLAW_KEYCHAIN_SERVICE || "everclaw-wallet-key";
const KEYCHAIN_DB =
  process.env.SAFE_KEYCHAIN_DB || process.env.EVERCLAW_KEYCHAIN_DB ||
  `${process.env.HOME}/Library/Keychains/everclaw.keychain-db`;
const KEYCHAIN_PASS_FILE =
  process.env.SAFE_KEYCHAIN_PASS_FILE || process.env.EVERCLAW_KEYCHAIN_PASS_FILE ||
  `${process.env.HOME}/.everclaw-keychain-pass`;

// Safe v1.4.1 canonical addresses on Base (8453)
const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

// --- ABIs ---
const SAFE_L2_ABI = parseAbi([
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
]);

const PROXY_FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);

// --- Helpers ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getPrivateKey() {
  // Try to unlock keychain via password file (optional -- keychain may already be unlocked)
  try {
    const pass = readFileSync(KEYCHAIN_PASS_FILE, "utf-8").trim();
    execFileSync("security", ["unlock-keychain", "-p", pass, KEYCHAIN_DB], {
      stdio: "pipe",
    });
  } catch {
    // Password file missing or unlock failed -- keychain may already be unlocked
  }

  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_SERVICE,
        "-w", KEYCHAIN_DB,
      ],
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
  } catch (e) {
    log(`ERROR: Could not retrieve wallet key from Keychain.`);
    log(`  Account: ${KEYCHAIN_ACCOUNT}, Service: ${KEYCHAIN_SERVICE}`);
    log(`  DB: ${KEYCHAIN_DB}`);
    log(`  Is the keychain unlocked? Run: security unlock-keychain ${KEYCHAIN_DB}`);
    process.exit(1);
  }
}

// --- Main ---
async function main() {
  const humanAddress = args.owner || process.env.SAFE_OWNER;
  const threshold = parseInt(args.threshold, 10);
  const dryRun = args["dry-run"];

  if (!humanAddress) {
    log("ERROR: --owner 0xAddress required (owner's personal wallet)");
    log("Usage: node scripts/safe-deploy.mjs --owner 0xYourAddress");
    process.exit(1);
  }

  // Validate address
  let ownerAddress;
  try {
    ownerAddress = getAddress(humanAddress);
  } catch {
    log(`ERROR: Invalid address: ${humanAddress}`);
    process.exit(1);
  }

  log("--- Safe deployment ---");
  log(`Chain: Base (8453)`);
  log(`Safe singleton: ${SAFE_L2_SINGLETON} (v1.4.1 L2)`);
  log(`Proxy factory: ${SAFE_PROXY_FACTORY}`);
  log(`Fallback handler: ${FALLBACK_HANDLER}`);

  // Get agent hot wallet
  let account;
  let agentAddress;

  if (args.agent) {
    // Use provided agent address (for dry-run or remote execution)
    try {
      agentAddress = getAddress(args.agent);
    } catch {
      log(`ERROR: Invalid agent address: ${args.agent}`);
      process.exit(1);
    }
    if (!dryRun) {
      log("ERROR: --agent flag only works with --dry-run. For real deployment, use Keychain.");
      process.exit(1);
    }
  } else {
    let privateKey = getPrivateKey();
    if (!privateKey.startsWith("0x")) {
      privateKey = `0x${privateKey}`;
    }
    account = privateKeyToAccount(privateKey);
    agentAddress = account.address;
  }

  // Sort owners deterministically (Safe requires sorted owner list for some operations)
  const owners = [ownerAddress, agentAddress].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  log(`Owner 1 (human): ${ownerAddress}`);
  log(`Owner 2 (Agent): ${agentAddress}`);
  log(`Threshold: ${threshold}-of-${owners.length}`);

  if (threshold < 1 || threshold > owners.length) {
    log(`ERROR: Threshold must be between 1 and ${owners.length}`);
    process.exit(1);
  }

  // Encode Safe.setup() initializer
  const initializer = encodeFunctionData({
    abi: SAFE_L2_ABI,
    functionName: "setup",
    args: [
      owners,           // _owners
      BigInt(threshold), // _threshold
      zeroAddress,      // to (no delegate call during setup)
      "0x",             // data (no delegate call data)
      FALLBACK_HANDLER, // fallbackHandler
      zeroAddress,      // paymentToken (no payment)
      0n,               // payment (no payment)
      zeroAddress,      // paymentReceiver (no payment)
    ],
  });

  // Generate salt nonce (random or user-specified)
  const saltNonce = args["salt-nonce"]
    ? BigInt(args["salt-nonce"])
    : BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("")}`);

  log(`Salt nonce: ${saltNonce}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  // Check deployer balance
  const ethBalance = await publicClient.getBalance({ address: agentAddress });
  log(`Agent ETH balance: ${formatEther(ethBalance)}`);

  if (ethBalance === 0n) {
    log("ERROR: Agent hot wallet has no ETH for gas. Fund it first.");
    process.exit(1);
  }

  if (dryRun) {
    log("--- DRY RUN --- (no transaction will be sent)");
    log("Initializer data:");
    log(`  ${initializer}`);
    log("To deploy for real, remove --dry-run flag.");
    return;
  }

  // Deploy
  log("Deploying Safe...");
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  try {
    const txHash = await walletClient.writeContract({
      address: SAFE_PROXY_FACTORY,
      abi: PROXY_FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    });

    log(`Transaction sent: ${txHash}`);
    log("Waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      log("ERROR: Transaction reverted!");
      log(`Receipt: ${JSON.stringify(receipt, null, 2)}`);
      process.exit(1);
    }

    // Extract Safe address from ProxyCreation event
    const proxyCreationTopic = "0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235";
    const creationLog = receipt.logs.find(
      (l) => l.topics[0] === proxyCreationTopic
    );

    let safeAddress;
    if (creationLog && creationLog.topics[1]) {
      // Address is in topic[1], zero-padded to 32 bytes
      safeAddress = getAddress("0x" + creationLog.topics[1].slice(26));
    } else {
      // Fallback: look for contract creation in logs
      log("WARNING: Could not find ProxyCreation event. Checking logs...");
      for (const l of receipt.logs) {
        log(`  Log: ${l.address} topics=${l.topics.length}`);
      }
      log("Check Basescan for the deployed Safe address.");
      process.exit(1);
    }

    log("");
    log("===========================================");
    log(`  Safe deployed: ${safeAddress}`);
    log("===========================================");
    log("");

    // Verify deployment
    log("Verifying deployment...");

    const version = await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_L2_ABI,
      functionName: "VERSION",
    });

    const deployedOwners = await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_L2_ABI,
      functionName: "getOwners",
    });

    const deployedThreshold = await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_L2_ABI,
      functionName: "getThreshold",
    });

    log(`  Version: ${version}`);
    log(`  Owners: ${deployedOwners.join(", ")}`);
    log(`  Threshold: ${deployedThreshold}-of-${deployedOwners.length}`);

    log("");
    log("Next steps:");
    log(`  1. Add to ~/morpheus/.env:`);
    log(`     SAFE_ADDRESS=${safeAddress}`);
    log(`  2. Verify on Basescan:`);
    log(`     https://basescan.org/address/${safeAddress}`);
    log(`  3. Run safe-configure.mjs to enable AllowanceModule`);

  } catch (e) {
    log(`ERROR: Deployment failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
