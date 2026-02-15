# safe-treasury

Multi-sig treasury management for autonomous AI agents using Safe Smart Account on Base.

## Purpose

This skill was extracted from `everclaw-fork` (branch `feature/safe-smart-account`) on 2026-02-14. Treasury management is a separate concern from Everclaw's inference routing -- the Safe is a standalone financial guardrail that any agent can use, not tied to a specific inference skill.

## Architecture

```
safe-treasury/
  SKILL.md              # OpenClaw skill manifest (frontmatter + docs)
  README.md             # User-facing summary
  CLAUDE.md             # This file -- project conventions for Claude Code
  package.json          # viem dependency (ESM)
  scripts/
    safe-deploy.mjs     # Deploy Safe v1.4.1 on Base (ProxyFactory)
    safe-configure.mjs  # Enable AllowanceModule + set spending limits
    safe-propose.mjs    # Multi-sig tx proposals via Safe Transaction Service
    safe-refill.mjs     # Auto-refill hot wallet (launchd daemon)
    install.sh          # Install launchd services
  templates/
    com.safe-treasury.refill.plist   # launchd template (every 6h)
  references/
    safe-deployment.md  # Deployment reference docs + contract ABIs
```

## Key Design Decisions

### Env Var Fallback Chain

All scripts use `SAFE_*` primary env vars with `EVERCLAW_*` fallback for backward compatibility:

```javascript
const RPC_URL = process.env.SAFE_RPC || process.env.EVERCLAW_RPC || "default";
```

This lets the agent's existing `~/morpheus/.env` (which has `EVERCLAW_*` vars) work without changes while new installations use the cleaner `SAFE_*` naming.

### No `@safe-global/safe-modules-deployments` Dependency

The everclaw package.json included this package, but the scripts never import it -- they hardcode the canonical contract addresses directly. Dropped to keep dependencies minimal.

### `loadEnv()` is Duplicated Across Scripts

Each script has its own `loadEnv()` and `getPrivateKey()` function. This is intentional -- each script is a standalone CLI tool that can run independently. No shared module, no build step.

### Safe v1.4.1 on Base

All scripts target Safe v1.4.1 canonical deployments on Base (chain ID 8453). The contract addresses are hardcoded:
- ProxyFactory: `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
- SafeL2 singleton: `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`
- FallbackHandler: `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`
- AllowanceModule: `0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134`

### EIP-712 Safe Transaction Signing

`safe-configure.mjs` and `safe-propose.mjs` compute Safe transaction hashes using EIP-712 typed data. The signature `v` value is adjusted by +4 for `eth_sign` style (Safe's convention for raw hash signatures vs. EIP-191 prefixed messages).

## Deployment (2026-02-15)

Safe deployed and configured on Base mainnet:

- **Safe**: [`0x740B13AdBC9eFD06AE283F59cE06915ff582B977`](https://basescan.org/address/0x740B13AdBC9eFD06AE283F59cE06915ff582B977)
- **Threshold**: 2-of-2
- **AllowanceModule**: 50 MOR/day, 0.05 ETH/day
- **Safe balance**: 1,920 MOR
- **Hot wallet float**: ~20.49 MOR + 0.016 ETH

See `references/safe-deployment.md` for full transaction log and lessons learned.

## Development

```bash
# Install dependencies
npm install

# Dry-run deploy (no transaction sent)
node scripts/safe-deploy.mjs --owner 0xAddress --agent 0xAgent --dry-run

# Dry-run configure (shows planned transactions)
node scripts/safe-configure.mjs --dry-run
```

## Extraction History

- **Source:** `everclaw-fork` repo, branch `feature/safe-smart-account`
- **Date:** 2026-02-14
- **Reason:** Treasury management is a separate concern from inference routing. The Safe is the single blocker for Phase 4 (DeFi) and needs its own identity as a skill.
- **Changes from source:**
  - Env vars renamed: `EVERCLAW_*` -> `SAFE_*` (with fallback)
  - `MORPHEUS_DIR` -> `SAFE_DIR` (with fallback)
  - `com.morpheus.refill` -> `com.safe-treasury.refill`
  - Dropped `@safe-global/safe-modules-deployments` dependency
  - Removed Everclaw-specific framing from docs
  - Added standalone `install.sh` (extracted from everclaw's `install-proxy.sh`)
