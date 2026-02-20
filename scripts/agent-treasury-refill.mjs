#!/usr/bin/env node
/**
 * agent-treasury-refill.mjs — Auto-refill hot wallet from Safe via AllowanceModule
 *
 * Checks hot wallet MOR and ETH balances on Base.
 * If below thresholds, pulls funds from Safe using executeAllowanceTransfer.
 * The hot wallet (delegate) calls the module directly — no signature needed.
 *
 * Runs as a launchd periodic job (com.safe-agent-treasury.refill, every 6 hours).
 *
 * Required in ~/morpheus/.env:
 *   SAFE_ADDRESS=0x...            Safe wallet address on Base
 *   SAFE_RPC=https://...          Base RPC URL (required - no public RPC fallback)
 *
 * Optional in ~/morpheus/.env:
 *   ALLOWANCE_MODULE=0x...        AllowanceModule address (default: Base deployment)
 *   MOR_LOW_THRESHOLD=20          MOR balance that triggers refill
 *   MOR_REFILL_AMOUNT=30          MOR to pull per refill
 *   ETH_LOW_THRESHOLD=0.01        ETH balance that triggers refill
 *   ETH_REFILL_AMOUNT=0.03        ETH to pull per refill
 *   ALERT_WEBHOOK_URL=https://... Webhook URL for failure alerts (Slack, Discord, etc.)
 */

import { readFileSync, openSync, closeSync, unlinkSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  parseAbi,
  zeroAddress,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// --- Load .env ---
const SAFE_DIR = process.env.SAFE_DIR || process.env.MORPHEUS_DIR || `${process.env.HOME}/morpheus`;

// --- File locking to prevent concurrent execution ---
const LOCK_FILE = `${SAFE_DIR}/.refill.lock`;

function acquireLock() {
  try {
    // O_EXCL fails if file exists - atomic check-and-create
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") {
      console.error(`[${new Date().toISOString()}] ERROR: Another refill instance is running (lock file exists: ${LOCK_FILE})`);
      process.exit(0); // Exit cleanly - not an error, just concurrent run
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
    // .env is optional if all vars are set via environment
  }
}

loadEnv(`${SAFE_DIR}/.env`);

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

// Thresholds (configurable via .env)
const MOR_LOW_THRESHOLD = parseEther(process.env.MOR_LOW_THRESHOLD || "20");
const MOR_REFILL_AMOUNT = parseEther(process.env.MOR_REFILL_AMOUNT || "30");
const ETH_LOW_THRESHOLD = parseEther(process.env.ETH_LOW_THRESHOLD || "0.01");
const ETH_REFILL_AMOUNT = parseEther(process.env.ETH_REFILL_AMOUNT || "0.03");

// Contract addresses (Base mainnet)
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const ALLOWANCE_MODULE =
  process.env.ALLOWANCE_MODULE ||
  "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134";

// --- ABIs ---
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const ALLOWANCE_MODULE_ABI = parseAbi([
  "function executeAllowanceTransfer(address safe, address token, address payable to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
]);

// Alerting (optional - set ALERT_WEBHOOK_URL for Slack/Discord notifications)
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

// --- Helpers ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Send alert to webhook (Slack, Discord, etc.) for critical failures.
 * Non-blocking - failure to send alert doesn't stop script.
 */
async function sendAlert(message, severity = "error") {
  if (!ALERT_WEBHOOK_URL) return;

  const payload = {
    text: `[safe-agent-treasury] [${severity.toUpperCase()}] ${message}`,
    timestamp: new Date().toISOString(),
    severity,
  };

  try {
    const response = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      log(`Alert webhook returned ${response.status}`);
    }
  } catch (e) {
    log(`Failed to send alert: ${e.message}`);
  }
}

/**
 * Retry wrapper for RPC operations.
 * Retries on transient network failures with exponential backoff.
 */
async function withRetry(fn, { maxRetries = 3, baseDelayMs = 1000, description = "RPC call" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isTransient =
        error.message?.includes("fetch") ||
        error.message?.includes("network") ||
        error.message?.includes("timeout") ||
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("ETIMEDOUT") ||
        error.code === "ECONNRESET";

      if (!isTransient || attempt === maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log(`  ${description} failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
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
    log(`  Unlock keychain first: security unlock-keychain "${KEYCHAIN_DB}"`);
    process.exit(1);
  }
}

// --- Main ---
async function main() {
  if (!SAFE_ADDRESS) {
    log("ERROR: SAFE_ADDRESS not set. Add it to ~/morpheus/.env");
    process.exit(1);
  }

  log("--- Safe refill check ---");
  log(`Safe: ${SAFE_ADDRESS}`);
  log(`AllowanceModule: ${ALLOWANCE_MODULE}`);

  let privateKey = getPrivateKey();
  if (!privateKey.startsWith("0x")) {
    privateKey = `0x${privateKey}`;
  }
  const account = privateKeyToAccount(privateKey);
  const hotWallet = account.address;
  log(`Hot wallet: ${hotWallet}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  // Check balances (with retry for transient RPC failures)
  const morBalance = await withRetry(
    () => publicClient.readContract({
      address: MOR_TOKEN,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [hotWallet],
    }),
    { description: "MOR balance check" }
  );
  const ethBalance = await withRetry(
    () => publicClient.getBalance({ address: hotWallet }),
    { description: "ETH balance check" }
  );

  log(`MOR balance: ${formatEther(morBalance)}`);
  log(`ETH balance: ${formatEther(ethBalance)}`);

  // --- MOR refill ---
  if (morBalance < MOR_LOW_THRESHOLD) {
    log(
      `MOR below ${formatEther(MOR_LOW_THRESHOLD)} threshold. Pulling ${formatEther(MOR_REFILL_AMOUNT)} from Safe...`
    );

    const morRefillArgs = [
      SAFE_ADDRESS,      // safe
      MOR_TOKEN,         // token
      hotWallet,         // to
      MOR_REFILL_AMOUNT, // amount (uint96)
      zeroAddress,       // paymentToken (no gas payment)
      0n,                // payment
      hotWallet,         // delegate (msg.sender == delegate, no sig needed)
      "0x",              // signature (empty — direct call by delegate)
    ];

    try {
      // Simulate first to avoid wasting gas on reverts
      log("  Simulating MOR refill...");
      await publicClient.simulateContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: morRefillArgs,
        account: hotWallet,
      });
      log("  Simulation OK. Sending transaction...");

      const tx = await walletClient.writeContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: morRefillArgs,
      });
      log(`MOR refill tx: ${tx}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`MOR refill: ${receipt.status === "success" ? "SUCCESS" : "REVERTED"}`);
      if (receipt.status !== "success") {
        await sendAlert(`MOR refill transaction reverted. Hot wallet may run out of MOR.`);
      }
    } catch (e) {
      const errMsg = e.shortMessage || e.message;
      log(`MOR refill failed: ${errMsg}`);

      // Check if this is a fundamental configuration issue
      const isFundamentalFailure =
        errMsg.includes("not a delegate") ||
        errMsg.includes("module") ||
        errMsg.includes("not enabled") ||
        errMsg.includes("invalid delegate") ||
        errMsg.includes("unauthorized");

      if (isFundamentalFailure) {
        log("FATAL: Fundamental configuration issue detected. Skipping ETH refill.");
        await sendAlert(`CRITICAL: Refill configuration broken - ${errMsg}`, "critical");
        log("Refill check complete (with errors).");
        return; // Exit early, don't try ETH
      }

      // Only alert if it's not an expected "allowance exhausted" type error
      if (!errMsg.includes("allowance") && !errMsg.includes("Allowance")) {
        await sendAlert(`MOR refill failed: ${errMsg}. Hot wallet may run out of MOR.`);
      }
    }
  } else {
    log("MOR balance OK.");
  }

  // --- ETH refill ---
  if (ethBalance < ETH_LOW_THRESHOLD) {
    log(
      `ETH below ${formatEther(ETH_LOW_THRESHOLD)} threshold. Pulling ${formatEther(ETH_REFILL_AMOUNT)} from Safe...`
    );

    const ethRefillArgs = [
      SAFE_ADDRESS,      // safe
      zeroAddress,       // token (address(0) = native ETH)
      hotWallet,         // to
      ETH_REFILL_AMOUNT, // amount (uint96)
      zeroAddress,       // paymentToken
      0n,                // payment
      hotWallet,         // delegate
      "0x",              // signature
    ];

    try {
      // Simulate first to avoid wasting gas on reverts
      log("  Simulating ETH refill...");
      await publicClient.simulateContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: ethRefillArgs,
        account: hotWallet,
      });
      log("  Simulation OK. Sending transaction...");

      const tx = await walletClient.writeContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: ethRefillArgs,
      });
      log(`ETH refill tx: ${tx}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`ETH refill: ${receipt.status === "success" ? "SUCCESS" : "REVERTED"}`);
      if (receipt.status !== "success") {
        await sendAlert(`ETH refill transaction reverted. Hot wallet may run out of gas.`);
      }
    } catch (e) {
      const errMsg = e.shortMessage || e.message;
      log(`ETH refill failed: ${errMsg}`);

      // Check if this is a fundamental configuration issue
      const isFundamentalFailure =
        errMsg.includes("not a delegate") ||
        errMsg.includes("module") ||
        errMsg.includes("not enabled") ||
        errMsg.includes("invalid delegate") ||
        errMsg.includes("unauthorized");

      if (isFundamentalFailure) {
        await sendAlert(`CRITICAL: Refill configuration broken - ${errMsg}`, "critical");
      } else if (!errMsg.includes("allowance") && !errMsg.includes("Allowance")) {
        // Only alert if it's not an expected "allowance exhausted" type error
        await sendAlert(`ETH refill failed: ${errMsg}. Hot wallet may run out of gas.`);
      }
    }
  } else {
    log("ETH balance OK.");
  }

  log("Refill check complete.");
}

main().catch(async (e) => {
  const errMsg = e.message;
  log(`FATAL: ${errMsg}`);
  await sendAlert(`CRITICAL: Refill daemon crashed - ${errMsg}`, "critical");
  process.exit(1);
});
