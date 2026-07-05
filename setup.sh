#!/bin/bash
# JobPilot one-command setup: bash setup.sh
set -e
cd "$(dirname "$0")"

echo ""
echo "  ✈️  JobPilot setup"
echo "  ─────────────────"

if ! command -v node >/dev/null 2>&1; then
  echo "  ❌ Node.js is not installed."
  echo "     Download the LTS version from https://nodejs.org , install it,"
  echo "     then run this command again:  bash setup.sh"
  exit 1
fi

# Update to the latest version when installed from GitHub
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo "  🔄 Checking for updates…"
  git pull --ff-only 2>/dev/null && echo "  ✓ Up to date" || echo "  (couldn't auto-update — continuing with current version)"
fi

if [ ! -d node_modules ]; then
  echo "  📦 Installing (first time only, ~1 minute)…"
fi
npm install --silent

DATA_DIR="${JOBPILOT_DATA:-$HOME/JobPilotData}"
mkdir -p "$DATA_DIR"
echo ""
echo "  📁 Your data folder:  $DATA_DIR"
if [ -f "$DATA_DIR/db.json" ]; then
  echo "     Existing data found — your dashboard will open ready to use."
else
  echo "     New install — the app will walk you through setup in the browser."
fi
echo "     💡 Back this folder up. Copy it to a new device + run setup there,"
echo "        and all your data comes with you."
echo ""
echo "  🌐 Opening http://localhost:4310 …  (keep this window open; Ctrl+C quits)"
echo ""

( sleep 2
  if command -v open >/dev/null 2>&1; then open http://localhost:4310
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:4310
  fi
) &

npm start
