# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-sig treasury management for autonomous AI agents using Safe Smart Account on Base. Agents operate as delegates with on-chain spending limits via AllowanceModule.

## Commands

```bash
# Install dependencies
npm install

# Run any script (all are standalone ESM, no build step)
node scripts/agent-treasury-deploy.mjs --owner 0xAddress --dry-run
node scripts/agent-treasury-configure.mjs --dry-run
node scripts/agent-treasury-status.mjs
node scripts/agent-treasury-refill.mjs
node scripts/agent-treasury-propose.mjs pending
```

All scripts support `--dry-run` where applicable.

## Architecture

### Script Design

Each script in `scripts/` is a standalone CLI tool:
- No shared modules, no build step
- Each script has its own `loadEnv()` and `getPrivateKey()` functions (intentionally duplicated)
- Uses viem for Ethereum interactions
- Retrieves private keys from macOS Keychain via `security` command

### Required Configuration

Scripts require explicit configuration in `~/morpheus/.env`:

```bash
SAFE_ADDRESS=0x...    # Safe wallet address on Base
SAFE_RPC=https://...  # Trusted RPC (Alchemy, Infura, QuickNode) - NO public RPC fallback
```

Optional:
```bash
ALERT_WEBHOOK_URL=https://...  # Webhook for refill daemon failure alerts (Slack, Discord)
```

Keychain must be pre-unlocked before running scripts:
```bash
security unlock-keychain ~/Library/Keychains/everclaw.keychain-db
```

### Env Var Fallback Chain

All scripts use `SAFE_*` primary env vars with `EVERCLAW_*` fallback for backward compatibility.
Config loaded from `~/morpheus/.env` (or `SAFE_DIR`/`MORPHEUS_DIR`).

### Safe v1.4.1 Hardcoded Addresses (Base, chain ID 8453)

```
ProxyFactory:    0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SafeL2 singleton: 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FallbackHandler: 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
AllowanceModule: 0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134
MOR Token:       0x7431aDa8a591C955a994a21710752EF9b882b8e3
```

### EIP-712 Safe Transaction Signing

`agent-treasury-configure.mjs` and `agent-treasury-propose.mjs` compute Safe transaction hashes using EIP-712 typed data. The signature `v` value is adjusted by +4 for `eth_sign` style (Safe's convention for raw hash signatures vs. EIP-191 prefixed messages).

### Known Issues

**RPC settle delay required:** RPC endpoints may serve stale nonce reads immediately after transaction confirms. Sequential Safe transactions can fail with `GS026`/`GS013`. The scripts include 5-second delays between sequential transactions.

### Security Hardening (2026-02-18)

**Critical fixes:**
- **No public RPC fallback** - Scripts require explicit `SAFE_RPC` configuration
- **No auto-unlock** - Keychain password no longer passed via CLI args (was visible in `ps aux`)
- **Daemon alerting** - Refill failures send webhook alerts when `ALERT_WEBHOOK_URL` is set

**High priority fixes:**
- **Input validation** - Hex data, uint96/uint16 bounds, threshold NaN checks
- **Nonce conflict detection** - Proposals check for existing pending transactions
- **File locking** - Refill and configure scripts use lock files to prevent concurrent execution
- **Restrictive permissions** - install.sh sets 700/600 on sensitive files and directories

**Medium priority fixes:**
- **Signature v-value validation** - Normalizes and validates v to 31/32 for eth_sign style
- **Transaction simulation** - Refill simulates before sending to avoid wasting gas
- **RPC retry logic** - Refill retries transient network failures with exponential backoff
- **Fundamental failure detection** - Refill skips remaining operations if configuration is broken
