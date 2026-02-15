#!/usr/bin/env node
/**
 * safe-refill.mjs — Auto-refill hot wallet from Safe via AllowanceModule
 *
 * Checks hot wallet MOR and ETH balances on Base.
 * If below thresholds, pulls funds from Safe using executeAllowanceTransfer.
 * The hot wallet (delegate) calls the module directly — no signature needed.
 *
 * Runs as a launchd periodic job (com.safe-treasury.refill, every 6 hours).
 *
 * Required in ~/morpheus/.env:
 *   SAFE_ADDRESS=0x...            Safe wallet address on Base
 *
 * Optional in ~/morpheus/.env:
 *   ALLOWANCE_MODULE=0x...        AllowanceModule address (default: Base deployment)
 *   MOR_LOW_THRESHOLD=20          MOR balance that triggers refill
 *   MOR_REFILL_AMOUNT=30          MOR to pull per refill
 *   ETH_LOW_THRESHOLD=0.01        ETH balance that triggers refill
 *   ETH_REFILL_AMOUNT=0.03        ETH to pull per refill
 *   SAFE_RPC=https://...          Base RPC URL
 */

import { readFileSync } from "node:fs";
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
    log(`  Is the keychain unlocked? Run: security unlock-keychain ${KEYCHAIN_DB}`);
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

  // Check balances
  const morBalance = await publicClient.readContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [hotWallet],
  });
  const ethBalance = await publicClient.getBalance({ address: hotWallet });

  log(`MOR balance: ${formatEther(morBalance)}`);
  log(`ETH balance: ${formatEther(ethBalance)}`);

  // --- MOR refill ---
  if (morBalance < MOR_LOW_THRESHOLD) {
    log(
      `MOR below ${formatEther(MOR_LOW_THRESHOLD)} threshold. Pulling ${formatEther(MOR_REFILL_AMOUNT)} from Safe...`
    );
    try {
      const tx = await walletClient.writeContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: [
          SAFE_ADDRESS,      // safe
          MOR_TOKEN,         // token
          hotWallet,         // to
          MOR_REFILL_AMOUNT, // amount (uint96)
          zeroAddress,       // paymentToken (no gas payment)
          0n,                // payment
          hotWallet,         // delegate (msg.sender == delegate, no sig needed)
          "0x",              // signature (empty — direct call by delegate)
        ],
      });
      log(`MOR refill tx: ${tx}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`MOR refill: ${receipt.status === "success" ? "SUCCESS" : "REVERTED"}`);
    } catch (e) {
      log(`MOR refill failed: ${e.shortMessage || e.message}`);
    }
  } else {
    log("MOR balance OK.");
  }

  // --- ETH refill ---
  if (ethBalance < ETH_LOW_THRESHOLD) {
    log(
      `ETH below ${formatEther(ETH_LOW_THRESHOLD)} threshold. Pulling ${formatEther(ETH_REFILL_AMOUNT)} from Safe...`
    );
    try {
      const tx = await walletClient.writeContract({
        address: ALLOWANCE_MODULE,
        abi: ALLOWANCE_MODULE_ABI,
        functionName: "executeAllowanceTransfer",
        args: [
          SAFE_ADDRESS,      // safe
          zeroAddress,       // token (address(0) = native ETH)
          hotWallet,         // to
          ETH_REFILL_AMOUNT, // amount (uint96)
          zeroAddress,       // paymentToken
          0n,                // payment
          hotWallet,         // delegate
          "0x",              // signature
        ],
      });
      log(`ETH refill tx: ${tx}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`ETH refill: ${receipt.status === "success" ? "SUCCESS" : "REVERTED"}`);
    } catch (e) {
      log(`ETH refill failed: ${e.shortMessage || e.message}`);
    }
  } else {
    log("ETH balance OK.");
  }

  log("Refill check complete.");
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
