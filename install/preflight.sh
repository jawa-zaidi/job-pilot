#!/bin/bash
# JobPilot preflight (macOS / Linux).
#
# This is the single shared entry point for every non-Finder way of starting
# JobPilot: JobPilot.command, setup.sh and `npm run launch` all end up here.
# Its only job is to find Node.js — everything after that lives in launch.js,
# which is cross-platform.
#
# Set JP_PAUSE_ON_EXIT=1 to keep the window open after an error (used by the
# double-click launcher, where closing the window would hide the message).

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || { echo "  Could not open the JobPilot folder."; exit 1; }

# shellcheck source=./find-node.sh
. "$HERE/find-node.sh"

jp_pause() {
  if [ "${JP_PAUSE_ON_EXIT:-0}" = "1" ]; then
    echo ""
    printf '  Press Return to close this window. '
    read -r _ 2>/dev/null || true
    echo ""
  fi
}

JP_NODE="$(jp_find_node)" || JP_NODE=""

if [ -z "$JP_NODE" ] && [ -f "$ROOT/runtime/bin/node" ]; then
  # The download brought its own Node, so "install Node.js" is the wrong advice
  # — this is the other Mac's file. Tell them that instead.
  echo ""
  echo "  ✈️  JobPilot"
  echo "  ──────────"
  jp_wrong_runtime_text
  jp_pause
  exit 1
fi

if [ -z "$JP_NODE" ]; then
  echo ""
  echo "  ✈️  JobPilot"
  echo "  ──────────"
  jp_node_missing_text

  if command -v open >/dev/null 2>&1; then
    open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  else
    echo "  (Open https://nodejs.org/en/download in your browser.)"
    echo ""
  fi

  jp_pause
  exit 1
fi

# Keep the double-click entry points runnable even if the executable bit was
# lost (downloading a .zip instead of using git can strip it).
chmod +x "$ROOT/JobPilot.command" "$HERE/preflight.sh" 2>/dev/null || true

"$JP_NODE" "$HERE/launch.js" "$@"
STATUS=$?

if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 130 ]; then
  jp_pause
fi

exit "$STATUS"
