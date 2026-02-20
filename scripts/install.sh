#!/bin/bash
# install.sh — Install safe-agent-treasury refill service with launchd persistence
#
# Sets up:
# 1. npm dependencies (viem)
# 2. agent-treasury-refill.mjs copied to ~/morpheus/
# 3. launchd plist for auto-refill (every 6 hours)
#
# Usage: bash scripts/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
SAFE_DIR="${SAFE_DIR:-${MORPHEUS_DIR:-$HOME/morpheus}}"
NODE_PATH="${NODE_PATH_OVERRIDE:-$(which node)}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "==========================================="
echo "  safe-agent-treasury — Service Installer"
echo "==========================================="
echo ""

# --- 1. Install npm dependencies ---
echo "[1/3] Installing Node dependencies..."
if [[ -f "$SKILL_DIR/package.json" ]]; then
  (cd "$SKILL_DIR" && npm install --silent 2>/dev/null) || {
    echo "   npm install failed. Run manually: cd $SKILL_DIR && npm install"
    exit 1
  }
  echo "   Dependencies installed."
else
  echo "   ERROR: package.json not found at $SKILL_DIR"
  exit 1
fi

# --- 2. Copy agent-treasury-refill.mjs ---
echo "[2/3] Installing agent-treasury-refill.mjs..."
mkdir -p "$SAFE_DIR/data/logs"

# SECURITY: Set restrictive permissions on all directories and files
chmod 700 "$SAFE_DIR"
chmod 700 "$SAFE_DIR/data"
chmod 700 "$SAFE_DIR/data/logs"

cp "$SCRIPT_DIR/agent-treasury-refill.mjs" "$SAFE_DIR/agent-treasury-refill.mjs"
chmod 700 "$SAFE_DIR/agent-treasury-refill.mjs"

# Secure .env if it exists (contains SAFE_ADDRESS, RPC credentials)
if [[ -f "$SAFE_DIR/.env" ]]; then
  chmod 600 "$SAFE_DIR/.env"
fi

# Secure existing log files
if [[ -f "$SAFE_DIR/data/logs/refill.log" ]]; then
  chmod 600 "$SAFE_DIR/data/logs/refill.log"
fi

echo "   Copied agent-treasury-refill.mjs -> $SAFE_DIR/ (mode 700)"

# --- 3. Install launchd plist (macOS only) ---
if [[ "$(uname)" == "Darwin" ]]; then
  echo "[3/3] Setting up launchd service..."
  mkdir -p "$LAUNCH_AGENTS"

  # Unload existing service
  launchctl unload "$LAUNCH_AGENTS/com.safe-agent-treasury.refill.plist" 2>/dev/null || true

  # Process template
  sed \
    -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__REFILL_SCRIPT_PATH__|$SAFE_DIR/agent-treasury-refill.mjs|g" \
    -e "s|__SAFE_DIR__|$SAFE_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SKILL_DIR/templates/com.safe-agent-treasury.refill.plist" > "$LAUNCH_AGENTS/com.safe-agent-treasury.refill.plist"

  # SECURITY: Restrict plist permissions (contains paths, not secrets, but good hygiene)
  chmod 644 "$LAUNCH_AGENTS/com.safe-agent-treasury.refill.plist"
  echo "   Installed com.safe-agent-treasury.refill.plist (mode 644)"

  # Load service
  launchctl load "$LAUNCH_AGENTS/com.safe-agent-treasury.refill.plist" 2>/dev/null
  echo "   Service loaded"

  sleep 2

  # Health check
  echo ""
  echo "--- Health Check ---"
  if launchctl list | grep -q "com.safe-agent-treasury.refill"; then
    echo "   [OK] Safe refill service (every 6 hours)"
  else
    echo "   [--] Safe refill service not loaded"
  fi
else
  echo "[3/3] Non-macOS detected. Skipping launchd setup."
  echo "   For Linux, create a systemd unit or cron job:"
  echo "   */6 * * * * node $SAFE_DIR/agent-treasury-refill.mjs >> $SAFE_DIR/data/logs/refill.log 2>&1"
fi

echo ""
echo "==========================================="
echo "  Installation complete!"
echo "==========================================="
echo ""
echo "  Refill log: $SAFE_DIR/data/logs/refill.log"
echo ""
echo "  Prerequisites:"
echo "    1. Safe deployed on Base with AllowanceModule enabled"
echo "    2. SAFE_ADDRESS set in $SAFE_DIR/.env"
echo "    3. Hot wallet added as delegate with daily limits"
echo ""
echo "  Deploy Safe:      node scripts/agent-treasury-deploy.mjs --owner 0xYourAddress"
echo "  Configure module: node scripts/agent-treasury-configure.mjs"
echo "  Manual refill:    node scripts/agent-treasury-refill.mjs"
echo ""
echo "  See SKILL.md for full setup instructions."
echo ""
