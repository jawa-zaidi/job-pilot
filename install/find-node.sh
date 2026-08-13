#!/bin/bash
# Shared helper: locate a usable Node.js binary on macOS / Linux.
#
# Source this file, then call `jp_find_node`. It prints the full path to node
# on stdout and returns 0, or prints nothing and returns 1.
#
# Why this exists: when JobPilot is launched from Finder (JobPilot.app) the
# process gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew, nvm,
# Volta and MacPorts installs of Node are invisible. We look a bit harder
# before telling someone Node is missing.

jp_find_node() {
  local candidate

  # 1. Already on PATH (the normal Terminal case).
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  # 2. Ask a login shell — this sources the profile where nvm/fnm/Volta live.
  candidate="$(/bin/bash -lc 'command -v node' 2>/dev/null | tail -n 1)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  # 3. Common install locations.
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /opt/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # 4. nvm — take the last version directory we can find.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    candidate="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort | tail -n 1)"
    if [ -n "$candidate" ] && [ -x "$HOME/.nvm/versions/node/$candidate/bin/node" ]; then
      printf '%s\n' "$HOME/.nvm/versions/node/$candidate/bin/node"
      return 0
    fi
  fi

  return 1
}

# Plain-language explanation shown when Node is missing. Kept here so the
# Terminal path and the .app path say exactly the same thing.
jp_node_missing_text() {
  cat <<'EOF'

  JobPilot needs one free program first: Node.js

  Node.js is what actually runs JobPilot on your computer. It is made by a
  non-profit foundation, it is free, and you only ever install it once.

  We just opened nodejs.org in your browser. There:

    1. Click the big green button that says "LTS" (that means "stable").
    2. Open the file it downloads and click Continue / Next until it finishes.
    3. Come back here and double-click JobPilot again.

  That's it — nothing to type, and you won't see this message again.

EOF
}
