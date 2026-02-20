#!/usr/bin/env node
/**
 * agent-treasury-configure.mjs — Enable AllowanceModule on Safe and set spending limits
 *
 * Executes four Safe transactions (sequentially):
 *   1. enableModule(AllowanceModule)
 *   2. addDelegate(agentHotWallet) on the AllowanceModule
 *   3. setAllowance(agent, MOR, amount, resetInterval) on the AllowanceModule
 *   4. setAllowance(agent, ETH, amount, resetInterval) on the AllowanceModule
 *
 * Requires threshold of 1 (agent can execute alone during setup).
 * For threshold 2+, use agent-treasury-propose.mjs instead.
 *
 * Usage:
 *   node scripts/agent-treasury-configure.mjs
 *   node scripts/agent-treasury-configure.mjs --mor-allowance 100 --eth-allowance 0.1
 *   node scripts/agent-treasury-configure.mjs --dry-run
 *
 * Required in ~/morpheus/.env:
 *   SAFE_ADDRESS=0x...
 *
 * Optional in ~/morpheus/.env:
 *   ALLOWANCE_MODULE=0x...        (default: Base deployment)
 *   MOR_DAILY_ALLOWANCE=50        MOR per day (default: 50)
 *   ETH_DAILY_ALLOWANCE=0.05      ETH per day (default: 0.05)
 *   SAFE_RPC=https://...          Base RPC URL
 */

import { readFileSync, openSync, closeSync, unlinkSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  parseAbi,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  toBytes,
  concat,
  pad,
  toHex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// --- Load .env ---
const SAFE_DIR = process.env.SAFE_DIR || process.env.MORPHEUS_DIR || `${process.env.HOME}/morpheus`;

// --- File locking to prevent concurrent execution ---
const LOCK_FILE = `${SAFE_DIR}/.configure.lock`;

function acquireLock() {
  try {
    // O_EXCL fails if file exists - atomic check-and-create
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") {
      console.error(`[ERROR] Another configure instance is running (lock file exists: ${LOCK_FILE})`);
      console.error("  If no other instance is running, delete the lock file manually.");
      process.exit(1);
    }
    throw e;
  }
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Ignore - lock file may already be removed
  }
}

// Acquire lock immediately on startup
acquireLock();

// Release lock on exit (normal or error)
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });

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
    "mor-allowance": { type: "string" },
    "eth-allowance": { type: "string" },
    "reset-minutes": { type: "string", default: "1440" },
    "dry-run": { type: "boolean", default: false },
  },
});

// --- Configuration ---
const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
// SECURITY: Require explicit RPC config. Public RPCs can return manipulated data.
const RPC_URL = process.env.SAFE_RPC || process.env.EVERCLAW_RPC;
if (!RPC_URL) {
  console.error("[ERROR] SAFE_RPC not configured in ~/morpheus/.env");
  console.error("  Public RPCs are NOT secure for financial operations.");
  console.error("  Use Alchemy, Infura, QuickNode, or your own node.");
  process.exit(1);
}

const KEYCHAIN_ACCOUNT =
  process.env.SAFE_KEYCHAIN_ACCOUNT || process.env.EVERCLAW_KEYCHAIN_ACCOUNT || "everclaw-agent";
const KEYCHAIN_SERVICE =
  process.env.SAFE_KEYCHAIN_SERVICE || process.env.EVERCLAW_KEYCHAIN_SERVICE || "everclaw-wallet-key";
const KEYCHAIN_DB =
  process.env.SAFE_KEYCHAIN_DB || process.env.EVERCLAW_KEYCHAIN_DB ||
  `${process.env.HOME}/Library/Keychains/everclaw.keychain-db`;
// KEYCHAIN_PASS_FILE removed - auto-unlock via CLI args exposed password in `ps aux`

// Contract addresses (Base mainnet)
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const ALLOWANCE_MODULE =
  process.env.ALLOWANCE_MODULE ||
  "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134";

// Allowance defaults
const MOR_DAILY_ALLOWANCE = parseEther(
  args["mor-allowance"] || process.env.MOR_DAILY_ALLOWANCE || "50"
);
const ETH_DAILY_ALLOWANCE = parseEther(
  args["eth-allowance"] || process.env.ETH_DAILY_ALLOWANCE || "0.05"
);
const RESET_MINUTES = parseInt(args["reset-minutes"], 10); // 1440 = 24 hours

// SECURITY: Validate bounds for uint96 (allowance amounts) and uint16 (reset minutes)
const UINT96_MAX = 2n ** 96n - 1n;
const UINT16_MAX = 65535;

if (MOR_DAILY_ALLOWANCE > UINT96_MAX) {
  console.error(`[ERROR] MOR allowance exceeds uint96 max (${formatEther(UINT96_MAX)})`);
  process.exit(1);
}
if (ETH_DAILY_ALLOWANCE > UINT96_MAX) {
  console.error(`[ERROR] ETH allowance exceeds uint96 max (${formatEther(UINT96_MAX)})`);
  process.exit(1);
}
if (Number.isNaN(RESET_MINUTES) || RESET_MINUTES < 1 || RESET_MINUTES > UINT16_MAX) {
  console.error(`[ERROR] --reset-minutes must be between 1 and ${UINT16_MAX}`);
  process.exit(1);
}

// --- ABIs ---
const SAFE_ABI = parseAbi([
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function domainSeparator() view returns (bytes32)",
]);

const ALLOWANCE_MODULE_ABI = parseAbi([
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
  "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, address next)",
]);

// Safe TX type hash (EIP-712)
const SAFE_TX_TYPEHASH = keccak256(
  toBytes(
    "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
  )
);

// --- Helpers ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getPrivateKey() {
  // SECURITY: Keychain must be pre-unlocked. We no longer auto-unlock via password file
  // because passing passwords via command-line args exposes them in `ps aux` output.
  // Before running: security unlock-keychain ~/Library/Keychains/everclaw.keychain-db
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
    log(`  Unlock keychain first: security unlock-keychain "${KEYCHAIN_DB}"`);
    process.exit(1);
  }
}

/**
 * Sign and execute a Safe transaction (threshold 1 only).
 * Returns the transaction receipt.
 */
async function execSafeTx(
  publicClient,
  walletClient,
  account,
  safeAddress,
  to,
  data,
  operation = 0 // 0 = Call, 1 = DelegateCall
) {
  // Get nonce and domain separator
  const [nonce, domainSeparator] = await Promise.all([
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "nonce",
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "domainSeparator",
    }),
  ]);

  // Compute Safe transaction hash (EIP-712)
  const safeTxHash = keccak256(
    concat([
      "0x1901",
      domainSeparator,
      keccak256(
        encodeAbiParameters(
          parseAbiParameters(
            "bytes32, address, uint256, bytes32, uint8, uint256, uint256, uint256, address, address, uint256"
          ),
          [
            SAFE_TX_TYPEHASH,
            to,
            0n, // value
            keccak256(data),
            operation,
            0n, // safeTxGas
            0n, // baseGas
            0n, // gasPrice
            zeroAddress, // gasToken
            zeroAddress, // refundReceiver
            nonce,
          ]
        )
      ),
    ])
  );

  // Sign the hash with the agent's key
  const signature = await account.signMessage({
    message: { raw: toBytes(safeTxHash) },
  });

  // Adjust v value for eth_sign (Safe expects v + 4)
  // Normalize v to 27/28 first if it's in recovery id format (0/1)
  const sigBytes = toBytes(signature);
  let v = sigBytes[64];
  if (v < 27) {
    v += 27; // Normalize 0/1 -> 27/28
  }
  sigBytes[64] = v + 4; // Add 4 for eth_sign style -> 31/32

  // Sanity check: v should now be 31 or 32
  if (sigBytes[64] !== 31 && sigBytes[64] !== 32) {
    throw new Error(`Unexpected signature v value: ${sigBytes[64]}`);
  }

  const adjustedSig = toHex(sigBytes);

  // Execute
  const txHash = await walletClient.writeContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      to,
      0n, // value
      data,
      operation,
      0n, // safeTxGas
      0n, // baseGas
      0n, // gasPrice
      zeroAddress, // gasToken
      zeroAddress, // refundReceiver
      adjustedSig,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  return { txHash, receipt, nonce };
}

// --- Main ---
async function main() {
  if (!SAFE_ADDRESS) {
    log("ERROR: SAFE_ADDRESS not set in ~/morpheus/.env");
    log("Deploy a Safe first with agent-treasury-deploy.mjs");
    process.exit(1);
  }

  const safeAddress = getAddress(SAFE_ADDRESS);
  const dryRun = args["dry-run"];

  log("--- Safe configuration ---");
  log(`Safe: ${safeAddress}`);
  log(`AllowanceModule: ${ALLOWANCE_MODULE}`);
  log(`MOR daily allowance: ${formatEther(MOR_DAILY_ALLOWANCE)} MOR`);
  log(`ETH daily allowance: ${formatEther(ETH_DAILY_ALLOWANCE)} ETH`);
  log(`Reset interval: ${RESET_MINUTES} minutes (${RESET_MINUTES / 60}h)`);

  // Get agent key
  let privateKey = getPrivateKey();
  if (!privateKey.startsWith("0x")) {
    privateKey = `0x${privateKey}`;
  }
  const account = privateKeyToAccount(privateKey);
  const agentAddress = account.address;
  log(`Agent: ${agentAddress}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  // Check current state
  const [threshold, owners, moduleEnabled] = await Promise.all([
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "getThreshold",
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "getOwners",
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "isModuleEnabled",
      args: [ALLOWANCE_MODULE],
    }),
  ]);

  log(`Threshold: ${threshold}-of-${owners.length}`);
  log(`Owners: ${owners.join(", ")}`);
  log(`AllowanceModule enabled: ${moduleEnabled}`);

  if (threshold > 1n) {
    log("ERROR: Threshold is > 1. Use agent-treasury-propose.mjs for multi-sig transactions.");
    log("Set threshold to 1 during setup, then raise after configuration.");
    process.exit(1);
  }

  // Verify agent is an owner
  const isOwner = owners.some(
    (o) => o.toLowerCase() === agentAddress.toLowerCase()
  );
  if (!isOwner) {
    log(`ERROR: Agent ${agentAddress} is not a Safe owner.`);
    process.exit(1);
  }

  if (dryRun) {
    log("--- DRY RUN --- (showing planned transactions)");
    if (!moduleEnabled) {
      log("  TX 1: enableModule(AllowanceModule)");
    } else {
      log("  TX 1: SKIP (module already enabled)");
    }
    log(`  TX 2: addDelegate(${agentAddress})`);
    log(
      `  TX 3: setAllowance(agent, MOR, ${formatEther(MOR_DAILY_ALLOWANCE)}, ${RESET_MINUTES}min)`
    );
    log(
      `  TX 4: setAllowance(agent, ETH, ${formatEther(ETH_DAILY_ALLOWANCE)}, ${RESET_MINUTES}min)`
    );
    log("To execute for real, remove --dry-run flag.");
    return;
  }

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  // --- TX 1: Enable AllowanceModule ---
  if (!moduleEnabled) {
    log("TX 1/4: Enabling AllowanceModule...");
    const enableData = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "enableModule",
      args: [ALLOWANCE_MODULE],
    });

    const result = await execSafeTx(
      publicClient,
      walletClient,
      account,
      safeAddress,
      safeAddress, // to = Safe itself
      enableData
    );

    log(
      `  ${result.receipt.status === "success" ? "OK" : "REVERTED"} tx: ${result.txHash}`
    );

    if (result.receipt.status !== "success") {
      log("ERROR: enableModule reverted. Aborting.");
      process.exit(1);
    }
  } else {
    log("TX 1/4: AllowanceModule already enabled. Skipping.");
  }

  // Wait for RPC state to catch up after previous tx
  const RPC_SETTLE_MS = 5000;
  async function settle() {
    log(`  Waiting ${RPC_SETTLE_MS / 1000}s for RPC state to settle...`);
    await new Promise((r) => setTimeout(r, RPC_SETTLE_MS));
  }

  await settle();

  // --- TX 2: Add delegate ---
  // Check if already registered
  const [delegates] = await publicClient.readContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "getDelegates",
    args: [safeAddress, 0, 10],
  });
  const alreadyDelegate = delegates.some(
    (d) => d.toLowerCase() === agentAddress.toLowerCase()
  );

  if (!alreadyDelegate) {
    log("TX 2/4: Adding agent as delegate...");
    const addDelegateData = encodeFunctionData({
      abi: ALLOWANCE_MODULE_ABI,
      functionName: "addDelegate",
      args: [agentAddress],
    });

    const delegateResult = await execSafeTx(
      publicClient,
      walletClient,
      account,
      safeAddress,
      ALLOWANCE_MODULE,
      addDelegateData
    );

    log(
      `  ${delegateResult.receipt.status === "success" ? "OK" : "REVERTED"} tx: ${delegateResult.txHash}`
    );

    if (delegateResult.receipt.status !== "success") {
      log("ERROR: addDelegate reverted. Aborting.");
      process.exit(1);
    }

    await settle();
  } else {
    log("TX 2/4: Agent already registered as delegate. Skipping.");
  }

  // --- TX 3: Set MOR allowance ---
  log(
    `TX 3/4: Setting MOR allowance (${formatEther(MOR_DAILY_ALLOWANCE)} MOR / ${RESET_MINUTES}min)...`
  );
  const setMorData = encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "setAllowance",
    args: [
      agentAddress,
      MOR_TOKEN,
      MOR_DAILY_ALLOWANCE, // uint96
      RESET_MINUTES, // uint16
      0, // resetBaseMin (uint32, start from now)
    ],
  });

  const morResult = await execSafeTx(
    publicClient,
    walletClient,
    account,
    safeAddress,
    ALLOWANCE_MODULE,
    setMorData
  );

  log(
    `  ${morResult.receipt.status === "success" ? "OK" : "REVERTED"} tx: ${morResult.txHash}`
  );

  await settle();

  // --- TX 4: Set ETH allowance ---
  log(
    `TX 4/4: Setting ETH allowance (${formatEther(ETH_DAILY_ALLOWANCE)} ETH / ${RESET_MINUTES}min)...`
  );
  const setEthData = encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "setAllowance",
    args: [
      agentAddress,
      zeroAddress, // address(0) = native ETH
      ETH_DAILY_ALLOWANCE, // uint96
      RESET_MINUTES, // uint16
      0, // resetBaseMin
    ],
  });

  const ethResult = await execSafeTx(
    publicClient,
    walletClient,
    account,
    safeAddress,
    ALLOWANCE_MODULE,
    setEthData
  );

  log(
    `  ${ethResult.receipt.status === "success" ? "OK" : "REVERTED"} tx: ${ethResult.txHash}`
  );

  // --- Verify ---
  log("");
  log("Verifying configuration...");

  const morAllowance = await publicClient.readContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "getTokenAllowance",
    args: [safeAddress, agentAddress, MOR_TOKEN],
  });

  const ethAllowance = await publicClient.readContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "getTokenAllowance",
    args: [safeAddress, agentAddress, zeroAddress],
  });

  // getTokenAllowance returns [amount, spent, resetTimeMin, lastReset, nonce]
  log(`  MOR: ${formatEther(morAllowance[0])} allowed, ${formatEther(morAllowance[1])} spent, resets every ${morAllowance[2]}min`);
  log(`  ETH: ${formatEther(ethAllowance[0])} allowed, ${formatEther(ethAllowance[1])} spent, resets every ${ethAllowance[2]}min`);

  const isEnabled = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "isModuleEnabled",
    args: [ALLOWANCE_MODULE],
  });

  log(`  Module enabled: ${isEnabled}`);
  log("");
  log("Configuration complete. agent-treasury-refill.mjs can now pull funds from this Safe.");
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
