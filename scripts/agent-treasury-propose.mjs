#!/usr/bin/env node
/**
 * agent-treasury-propose.mjs — Propose multi-sig transactions to Safe Transaction Service
 *
 * Creates a Safe transaction, signs it with the agent's key, and submits
 * to the Safe Transaction Service for co-signing via Safe Wallet app.
 *
 * Commands:
 *   propose   -- Propose a raw transaction (target, value, data)
 *   transfer  -- Propose a token or ETH transfer
 *   threshold -- Propose changing the Safe threshold
 *   pending   -- List pending transactions awaiting signatures
 *   confirm   -- Add agent's signature to a pending transaction
 *
 * Usage:
 *   node scripts/agent-treasury-propose.mjs transfer --token MOR --to 0x... --amount 100
 *   node scripts/agent-treasury-propose.mjs transfer --token ETH --to 0x... --amount 0.5
 *   node scripts/agent-treasury-propose.mjs threshold --value 2
 *   node scripts/agent-treasury-propose.mjs pending
 *   node scripts/agent-treasury-propose.mjs confirm --hash 0x...
 *   node scripts/agent-treasury-propose.mjs propose --to 0x... --data 0x... --value 0
 *
 * Required in ~/morpheus/.env:
 *   SAFE_ADDRESS=0x...
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  parseAbi,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  toBytes,
  concat,
  toHex,
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

const KEYCHAIN_ACCOUNT =
  process.env.SAFE_KEYCHAIN_ACCOUNT || process.env.EVERCLAW_KEYCHAIN_ACCOUNT || "everclaw-agent";
const KEYCHAIN_SERVICE =
  process.env.SAFE_KEYCHAIN_SERVICE || process.env.EVERCLAW_KEYCHAIN_SERVICE || "everclaw-wallet-key";
const KEYCHAIN_DB =
  process.env.SAFE_KEYCHAIN_DB || process.env.EVERCLAW_KEYCHAIN_DB ||
  `${process.env.HOME}/Library/Keychains/everclaw.keychain-db`;
// KEYCHAIN_PASS_FILE removed - auto-unlock via CLI args exposed password in `ps aux`

// Contract addresses
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";

// --- ABIs ---
const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function domainSeparator() view returns (bytes32)",
  "function changeThreshold(uint256 _threshold)",
]);

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
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
    log(`  Unlock keychain first: security unlock-keychain "${KEYCHAIN_DB}"`);
    process.exit(1);
  }
}

/**
 * Compute the Safe transaction hash (EIP-712).
 */
function computeSafeTxHash(domainSeparator, txData) {
  return keccak256(
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
            txData.to,
            txData.value,
            keccak256(txData.data),
            txData.operation,
            0n, // safeTxGas
            0n, // baseGas
            0n, // gasPrice
            zeroAddress, // gasToken
            zeroAddress, // refundReceiver
            txData.nonce,
          ]
        )
      ),
    ])
  );
}

/**
 * Sign a Safe transaction hash with the agent key (eth_sign style).
 */
async function signSafeTxHash(account, safeTxHash) {
  const signature = await account.signMessage({
    message: { raw: toBytes(safeTxHash) },
  });

  // Adjust v for eth_sign (Safe expects v + 4)
  // Normalize v to 27/28 first if it's in recovery id format (0/1)
  const sigBytes = toBytes(signature);
  let v = sigBytes[64];
  if (v < 27) {
    v += 27; // Normalize 0/1 -> 27/28
  }
  sigBytes[64] = v + 4; // Add 4 for eth_sign style -> 31/32

  // Sanity check: v should now be 31 or 32
  if (sigBytes[64] !== 31 && sigBytes[64] !== 32) {
    throw new Error(`Unexpected signature v value after adjustment: ${sigBytes[64]} (original: ${v - (v >= 27 ? 0 : 27)})`);
  }

  return toHex(sigBytes);
}

/**
 * Submit a proposed transaction to the Safe Transaction Service.
 */
async function submitToTxService(safeAddress, txData, safeTxHash, signature, senderAddress) {
  const url = `${TX_SERVICE_URL}/api/v1/safes/${safeAddress}/multisig-transactions/`;

  const body = {
    to: txData.to,
    value: txData.value.toString(),
    data: txData.data,
    operation: txData.operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: txData.nonce.toString(),
    contractTransactionHash: safeTxHash,
    sender: senderAddress,
    signature: signature,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transaction Service error (${response.status}): ${errorText}`);
  }

  return response.status;
}

/**
 * Submit a confirmation (signature) for an existing pending transaction.
 */
async function submitConfirmation(safeTxHash, signature) {
  const url = `${TX_SERVICE_URL}/api/v1/multisig-transactions/${safeTxHash}/confirmations/`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Confirmation error (${response.status}): ${errorText}`);
  }

  return response.status;
}

/**
 * Fetch pending transactions from the Transaction Service.
 */
async function getPendingTransactions(safeAddress) {
  const url = `${TX_SERVICE_URL}/api/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=10`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch pending txs: ${response.status}`);
  }

  const data = await response.json();
  return data.results || [];
}

// --- Commands ---

async function cmdPropose(publicClient, account, safeAddress, targetArgs) {
  const to = getAddress(targetArgs.to);
  const value = targetArgs.value ? BigInt(targetArgs.value) : 0n;
  const data = targetArgs.data || "0x";

  // SECURITY: Validate hex data format
  if (data !== "0x" && !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    log("ERROR: Invalid --data format. Must be '0x' followed by even number of hex characters.");
    log("  Example: 0x or 0xa9059cbb000000...");
    process.exit(1);
  }

  const operation = targetArgs.operation || 0;

  const [nonce, domainSeparator, pendingTxs] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "nonce" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "domainSeparator" }),
    getPendingTransactions(safeAddress),
  ]);

  // SECURITY: Check for nonce conflicts with pending transactions
  const conflictingTx = pendingTxs.find(tx => BigInt(tx.nonce) === nonce);
  if (conflictingTx) {
    log(`ERROR: Pending transaction already exists at nonce ${nonce}:`);
    log(`  Safe TX hash: ${conflictingTx.safeTxHash}`);
    log(`  To: ${conflictingTx.to}`);
    log(`  Value: ${formatEther(BigInt(conflictingTx.value))} ETH`);
    log("");
    log("Options:");
    log("  1. Execute or reject the pending tx first");
    log("  2. Use 'confirm --hash <safeTxHash>' to co-sign the existing tx");
    process.exit(1);
  }

  const txData = { to, value, data, operation, nonce };
  const safeTxHash = computeSafeTxHash(domainSeparator, txData);
  const signature = await signSafeTxHash(account, safeTxHash);

  log(`Safe TX hash: ${safeTxHash}`);
  log(`Submitting to Transaction Service...`);

  const status = await submitToTxService(
    safeAddress,
    txData,
    safeTxHash,
    signature,
    account.address
  );

  log(`Submitted (${status}). Waiting for co-signatures in Safe Wallet app.`);
  log(`  View: https://app.safe.global/transactions/queue?safe=base:${safeAddress}`);
}

async function cmdTransfer(publicClient, account, safeAddress, transferArgs) {
  const token = (transferArgs.token || "").toUpperCase();
  const to = getAddress(transferArgs.to);
  const amount = parseEther(transferArgs.amount);

  // Validate amount is positive
  if (amount <= 0n) {
    log("ERROR: --amount must be greater than 0");
    process.exit(1);
  }

  let txTo, txValue, txData;

  if (token === "ETH") {
    txTo = to;
    txValue = amount;
    txData = "0x";
    log(`Proposing: Transfer ${formatEther(amount)} ETH to ${to}`);
  } else if (token === "MOR") {
    txTo = MOR_TOKEN;
    txValue = 0n;
    txData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
    });
    log(`Proposing: Transfer ${formatEther(amount)} MOR to ${to}`);
  } else {
    log(`ERROR: Unknown token "${token}". Use --token MOR or --token ETH`);
    process.exit(1);
  }

  await cmdPropose(publicClient, account, safeAddress, {
    to: txTo,
    value: txValue.toString(),
    data: txData,
  });
}

async function cmdThreshold(publicClient, account, safeAddress, thresholdArgs) {
  const newThreshold = parseInt(thresholdArgs.value, 10);
  const owners = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getOwners",
  });

  if (Number.isNaN(newThreshold) || newThreshold < 1 || newThreshold > owners.length) {
    log(`ERROR: Threshold must be a number between 1 and ${owners.length}`);
    process.exit(1);
  }

  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "changeThreshold",
    args: [BigInt(newThreshold)],
  });

  log(`Proposing: Change threshold to ${newThreshold}-of-${owners.length}`);

  await cmdPropose(publicClient, account, safeAddress, {
    to: safeAddress,
    value: "0",
    data,
  });
}

async function cmdPending(safeAddress) {
  log(`Fetching pending transactions for ${safeAddress}...`);
  const pending = await getPendingTransactions(safeAddress);

  if (pending.length === 0) {
    log("No pending transactions.");
    return;
  }

  log(`Found ${pending.length} pending transaction(s):\n`);
  for (const tx of pending) {
    const confirmCount = tx.confirmations ? tx.confirmations.length : 0;
    log(`  Safe TX hash: ${tx.safeTxHash}`);
    log(`    To: ${tx.to}`);
    log(`    Value: ${formatEther(BigInt(tx.value))} ETH`);
    log(`    Data: ${tx.data ? tx.data.slice(0, 20) + "..." : "(none)"}`);
    log(`    Nonce: ${tx.nonce}`);
    log(`    Confirmations: ${confirmCount}/${tx.confirmationsRequired}`);
    if (tx.confirmations) {
      for (const c of tx.confirmations) {
        log(`      - ${c.owner}`);
      }
    }
    log("");
  }
}

async function cmdConfirm(publicClient, account, safeAddress, confirmArgs) {
  const safeTxHash = confirmArgs.hash;
  if (!safeTxHash) {
    log("ERROR: --hash required. Get it from 'pending' command.");
    process.exit(1);
  }

  log(`Signing transaction ${safeTxHash}...`);
  const signature = await signSafeTxHash(account, safeTxHash);
  const status = await submitConfirmation(safeTxHash, signature);

  log(`Confirmation submitted (${status}).`);
  log(`  View: https://app.safe.global/transactions/queue?safe=base:${safeAddress}`);
}

// --- Main ---
async function main() {
  if (!SAFE_ADDRESS) {
    log("ERROR: SAFE_ADDRESS not set in ~/morpheus/.env");
    process.exit(1);
  }

  const safeAddress = getAddress(SAFE_ADDRESS);
  const command = process.argv[2];

  if (!command || command === "--help") {
    console.log(`
Usage: node scripts/agent-treasury-propose.mjs <command> [options]

Commands:
  propose    --to 0x... [--data 0x...] [--value 0]   Propose raw transaction
  transfer   --token MOR|ETH --to 0x... --amount N    Propose token transfer
  threshold  --value N                                 Propose threshold change
  pending                                              List pending transactions
  confirm    --hash 0x...                              Confirm a pending transaction
`);
    return;
  }

  // Parse remaining args (after command)
  const cmdArgs = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      cmdArgs[key] = value;
      if (value !== "true") i++;
    }
  }

  // For 'pending', no key needed
  if (command === "pending") {
    await cmdPending(safeAddress);
    return;
  }

  // All other commands need the agent key
  let privateKey = getPrivateKey();
  if (!privateKey.startsWith("0x")) {
    privateKey = `0x${privateKey}`;
  }
  const account = privateKeyToAccount(privateKey);
  log(`Agent: ${account.address}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  switch (command) {
    case "propose":
      if (!cmdArgs.to) {
        log("ERROR: --to required");
        process.exit(1);
      }
      await cmdPropose(publicClient, account, safeAddress, cmdArgs);
      break;

    case "transfer":
      if (!cmdArgs.token || !cmdArgs.to || !cmdArgs.amount) {
        log("ERROR: --token, --to, and --amount required");
        process.exit(1);
      }
      await cmdTransfer(publicClient, account, safeAddress, cmdArgs);
      break;

    case "threshold":
      if (!cmdArgs.value) {
        log("ERROR: --value required (new threshold number)");
        process.exit(1);
      }
      await cmdThreshold(publicClient, account, safeAddress, cmdArgs);
      break;

    case "confirm":
      await cmdConfirm(publicClient, account, safeAddress, cmdArgs);
      break;

    default:
      log(`ERROR: Unknown command "${command}". Run with --help.`);
      process.exit(1);
  }
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
