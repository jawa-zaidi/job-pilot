#!/bin/bash
# ✈️  JobPilot — double-click this file to start.
#
# The first time you run it, macOS may say it "cannot be opened because it is
# from an unidentified developer". If so: right-click this file, choose Open,
# then click Open again. You only ever have to do that once.

cd "$(dirname "$0")" || exit 1
export JP_PAUSE_ON_EXIT=1
exec /bin/bash "./install/preflight.sh" "$@"
