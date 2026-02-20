#!/usr/bin/env node
/**
 * agent-treasury-status.mjs — Read-only dashboard for Safe treasury status
 *
 * Shows Safe overview, balances, daily allowance usage, pending
 * transactions, and refill daemon health. No private key required.
 *
 * Usage:
 *   node scripts/agent-treasury-status.mjs
 *   node scripts/agent-treasury-status.mjs --json
 *
 * Required in ~/morpheus/.env:
 *   SAFE_ADDRESS=0x...            Safe wallet address on Base
 *
 * Optional in ~/morpheus/.env:
 *   ALLOWANCE_MODULE=0x...        AllowanceModule address (default: Base deployment)
 *   SAFE_RPC=https://...          Base RPC URL
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  http,
  formatEther,
  parseAbi,
  getAddress,
  zeroAddress,
} from "viem";
import { base } from "viem/chains";

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

// Safe Transaction Service for Base
const TX_SERVICE_URL =
  process.env.SAFE_TX_SERVICE || "https://safe-transaction-base.safe.global";

// Contract addresses (Base mainnet)
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const ALLOWANCE_MODULE =
  process.env.ALLOWANCE_MODULE ||
  "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134";

// CLI flags
const JSON_OUTPUT = process.argv.includes("--json");

// --- ABIs ---
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const SAFE_ABI = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
]);

const ALLOWANCE_MODULE_ABI = parseAbi([
  "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, address next)",
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
]);

// --- Helpers ---
function log(msg) {
  if (!JSON_OUTPUT) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }
}

// --- Main ---
async function main() {
  if (!SAFE_ADDRESS) {
    log("ERROR: SAFE_ADDRESS not set. Add it to ~/morpheus/.env");
    process.exit(1);
  }

  const safeAddress = getAddress(SAFE_ADDRESS);
  const result = {};

  log("=== Safe Treasury Status ===");
  log("");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  // --- 1. Safe Overview ---
  log("--- Safe Overview ---");
  const [threshold, owners, nonce, moduleEnabled] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getThreshold" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getOwners" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "nonce" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "isModuleEnabled", args: [ALLOWANCE_MODULE] }),
  ]);

  log(`  Address:          ${safeAddress}`);
  log(`  Chain:            Base (8453)`);
  log(`  Threshold:        ${threshold}-of-${owners.length}`);
  log(`  Owners:           ${owners.join(", ")}`);
  log(`  AllowanceModule:  ${moduleEnabled ? "enabled" : "NOT enabled"}`);
  log(`  Nonce:            ${nonce}`);

  result.safe = {
    address: safeAddress,
    chain: "base",
    chainId: 8453,
    threshold: Number(threshold),
    ownerCount: owners.length,
    owners: owners.map(String),
    allowanceModuleEnabled: moduleEnabled,
    nonce: Number(nonce),
  };

  // --- 2. Balances ---
  log("");
  log("--- Balances ---");

  const safeMor = await publicClient.readContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [safeAddress],
  });
  const safeEth = await publicClient.getBalance({ address: safeAddress });

  log(`  Safe MOR:         ${formatEther(safeMor)}`);
  log(`  Safe ETH:         ${formatEther(safeEth)}`);

  result.balances = {
    safe: {
      mor: formatEther(safeMor),
      eth: formatEther(safeEth),
    },
    delegates: {},
  };

  // --- 3. Delegates & Allowances ---
  log("");
  log("--- Daily Allowances ---");

  let delegates = [];
  try {
    const [delegateList] = await publicClient.readContract({
      address: ALLOWANCE_MODULE,
      abi: ALLOWANCE_MODULE_ABI,
      functionName: "getDelegates",
      args: [safeAddress, 0, 50],
    });
    delegates = delegateList;
  } catch {
    log("  Could not fetch delegates from AllowanceModule.");
  }

  if (delegates.length === 0) {
    log("  No delegates configured.");
  }

  result.allowances = [];

  for (const delegate of delegates) {
    log(`  Delegate: ${delegate}`);

    // Fetch delegate balances
    const [delegateMor, delegateEth] = await Promise.all([
      publicClient.readContract({
        address: MOR_TOKEN,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [delegate],
      }),
      publicClient.getBalance({ address: delegate }),
    ]);

    log(`    Wallet MOR:     ${formatEther(delegateMor)}`);
    log(`    Wallet ETH:     ${formatEther(delegateEth)}`);

    result.balances.delegates[delegate] = {
      mor: formatEther(delegateMor),
      eth: formatEther(delegateEth),
    };

    // Fetch MOR allowance: returns [amount, spent, resetTimeMin, lastResetMin, nonce]
    const morAllowance = await publicClient.readContract({
      address: ALLOWANCE_MODULE,
      abi: ALLOWANCE_MODULE_ABI,
      functionName: "getTokenAllowance",
      args: [safeAddress, delegate, MOR_TOKEN],
    });

    // Fetch ETH allowance
    const ethAllowance = await publicClient.readContract({
      address: ALLOWANCE_MODULE,
      abi: ALLOWANCE_MODULE_ABI,
      functionName: "getTokenAllowance",
      args: [safeAddress, delegate, zeroAddress],
    });

    for (const [label, token, allowance] of [
      ["MOR", MOR_TOKEN, morAllowance],
      ["ETH", zeroAddress, ethAllowance],
    ]) {
      const amount = allowance[0];
      const spent = allowance[1];
      const resetTimeMin = Number(allowance[2]);
      const lastResetMin = Number(allowance[3]);
      const allowanceNonce = Number(allowance[4]);

      if (amount === 0n) {
        log(`    ${label} allowance: not configured`);
        continue;
      }

      const remaining = spent > amount ? 0n : amount - spent;
      const remainingStr = spent > amount
        ? "0 (over limit)"
        : formatEther(remaining);

      let nextResetStr;
      if (lastResetMin === 0) {
        nextResetStr = "Not yet used";
      } else {
        const nextResetTimestamp = (lastResetMin + resetTimeMin) * 60;
        const nextReset = new Date(nextResetTimestamp * 1000);
        const now = Date.now();
        if (nextReset.getTime() <= now) {
          nextResetStr = "Reset available now";
        } else {
          const diffMs = nextReset.getTime() - now;
          const diffH = Math.floor(diffMs / 3_600_000);
          const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
          nextResetStr = `${nextReset.toISOString()} (in ${diffH}h ${diffM}m)`;
        }
      }

      log(`    ${label} limit:      ${formatEther(amount)} / ${resetTimeMin}min`);
      log(`    ${label} spent:      ${formatEther(spent)}`);
      log(`    ${label} remaining:  ${remainingStr}`);
      log(`    ${label} next reset: ${nextResetStr}`);

      result.allowances.push({
        delegate,
        token: label,
        tokenAddress: token,
        limit: formatEther(amount),
        spent: formatEther(spent),
        remaining: spent > amount ? "0" : formatEther(remaining),
        resetIntervalMin: resetTimeMin,
        lastResetMin,
        nextReset: nextResetStr,
        nonce: allowanceNonce,
      });
    }
  }

  // --- 4. Pending Transactions ---
  log("");
  log("--- Pending Transactions ---");

  result.pendingTransactions = [];

  try {
    const url = `${TX_SERVICE_URL}/api/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=10`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const pending = data.results || [];

    if (pending.length === 0) {
      log("  No pending transactions.");
    } else {
      log(`  ${pending.length} pending transaction(s):`);
      for (const tx of pending) {
        const confirmCount = tx.confirmations ? tx.confirmations.length : 0;
        log("");
        log(`  Safe TX hash: ${tx.safeTxHash}`);
        log(`    To:            ${tx.to}`);
        log(`    Value:         ${formatEther(BigInt(tx.value))} ETH`);
        log(`    Data:          ${tx.data ? tx.data.slice(0, 20) + "..." : "(none)"}`);
        log(`    Nonce:         ${tx.nonce}`);
        log(`    Confirmations: ${confirmCount}/${tx.confirmationsRequired}`);
        if (tx.confirmations) {
          for (const c of tx.confirmations) {
            log(`      - ${c.owner}`);
          }
        }

        result.pendingTransactions.push({
          safeTxHash: tx.safeTxHash,
          to: tx.to,
          value: formatEther(BigInt(tx.value)),
          data: tx.data || null,
          nonce: tx.nonce,
          confirmations: confirmCount,
          confirmationsRequired: tx.confirmationsRequired,
          signers: tx.confirmations ? tx.confirmations.map((c) => c.owner) : [],
        });
      }
    }
  } catch (e) {
    log(`  Could not fetch pending transactions: ${e.message}`);
    result.pendingTransactions = null;
  }

  // --- 5. Refill Daemon ---
  log("");
  log("--- Refill Daemon ---");

  result.refillDaemon = {};

  try {
    const launchdStatus = execFileSync(
      "launchctl",
      ["list", "com.safe-agent-treasury.refill"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    // launchctl list <label> outputs key-value pairs if the job exists
    const pidMatch = launchdStatus.match(/"PID"\s*=\s*(\d+)/);
    const statusMatch = launchdStatus.match(/"LastExitStatus"\s*=\s*(\d+)/);
    const pid = pidMatch ? pidMatch[1] : null;
    const lastExit = statusMatch ? statusMatch[1] : null;

    log(`  Service:          com.safe-agent-treasury.refill`);
    log(`  Status:           loaded${pid ? ` (PID ${pid})` : ""}`);
    log(`  Last exit status: ${lastExit !== null ? lastExit : "unknown"}`);

    result.refillDaemon.loaded = true;
    result.refillDaemon.pid = pid ? Number(pid) : null;
    result.refillDaemon.lastExitStatus = lastExit !== null ? Number(lastExit) : null;
  } catch {
    log("  Service:          com.safe-agent-treasury.refill");
    log("  Status:           not loaded");

    result.refillDaemon.loaded = false;
  }

  // Check last log line
  const logPath = `${SAFE_DIR}/data/logs/refill.log`;
  try {
    const logContent = readFileSync(logPath, "utf-8");
    const lines = logContent.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    log(`  Last log:         ${lastLine}`);
    result.refillDaemon.lastLog = lastLine;
  } catch {
    log(`  Last log:         no log file found (${logPath})`);
    result.refillDaemon.lastLog = null;
  }

  // --- JSON output ---
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
  }

  log("");
  log("=== Status check complete ===");
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
