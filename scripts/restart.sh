#!/bin/bash
# Restart the OB2 platform. Passes all args to start.sh.
#
# Usage:
#   scripts/restart.sh                         # restart server only
#   scripts/restart.sh --with-postgres         # restart server + Docker DB

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Stop (pass --with-postgres if specified)
"$SCRIPT_DIR/stop.sh" "$@"

sleep 1

# Start
"$SCRIPT_DIR/start.sh" "$@"
