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
#
# The download from the website has its own copy of Node inside it, in
# runtime/, and that is always preferred: it is the version JobPilot was tested
# against, and it means nobody has to install anything. A `git clone` has no
# runtime/ folder, so developers carry on using their own Node exactly as before.

# Get a bundled runtime ready to run, and answer whether it actually works.
# Silent: jp_find_node prints a path on stdout, so nothing here may.
jp_ready_bundled_node() {
  local node="$1"

  # Anything downloaded from the internet arrives with macOS's "quarantine"
  # label on it, and macOS refuses to run a quarantined program unless its
  # author has paid Apple to vouch for them. The person double-clicking has
  # already got past that box once for the launcher itself (right-click →
  # Open); this clears the same label from the runtime that came down in the
  # same ZIP, so there is never a second scary message.
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$node" >/dev/null 2>&1 || true
  fi

  # Unzipping can lose the "this is a program" bit.
  [ -x "$node" ] || chmod +x "$node" >/dev/null 2>&1 || true

  # The only test that means anything: does it run on this machine?
  "$node" -v >/dev/null 2>&1
}

jp_find_node() {
  local candidate
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"

  # 0. The copy of Node that came inside the download. Nothing to install.
  candidate="$root/runtime/bin/node"
  if [ -f "$candidate" ] && jp_ready_bundled_node "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  # If it is there but will not run, this is almost always an Intel download on
  # an Apple Silicon Mac or the other way round. Say nothing and carry on
  # looking — a Node already on the machine will do the job just as well.

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

# Shown when the download did contain a runtime but it would not run here —
# in practice, the Intel download on an Apple Silicon Mac or the reverse.
jp_wrong_runtime_text() {
  cat <<'EOF'

  This looks like the download for a different kind of Mac.

  JobPilot comes in two Mac versions, and the copy of Node inside this one will
  not run on this computer. Nothing is broken and nothing has been installed.

    1. Open  https://github.com/jawa-zaidi/job-pilot/releases/latest
    2. Apple menu → About This Mac. If it says "Apple M1" (or M2, M3, M4),
       download the Apple Silicon file; if it says "Intel", download the
       Intel one.
    3. Unzip it and double-click JobPilot in the new folder.

EOF
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
