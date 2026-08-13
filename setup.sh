#!/bin/bash
# JobPilot one-command setup: bash setup.sh
#
# This still works exactly as it always did. If you'd rather not touch a
# Terminal at all, just double-click JobPilot.command instead — it's the same
# thing with no typing.
#
# The real work lives in install/preflight.sh + install/launch.js, which every
# way of starting JobPilot shares.

cd "$(dirname "$0")" || exit 1
exec /bin/bash "./install/preflight.sh" "$@"
