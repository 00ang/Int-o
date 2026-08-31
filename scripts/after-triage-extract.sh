#!/bin/sh
# Wait for the triage sweep to finish, then extract everything it retained.
#
# Chained rather than run together: extraction only has work once triage has
# decided what is worth extracting, and running both against one rate limit
# would have them starve each other.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/allint-extract-sweep.log

while pgrep -f triage-sweep.sh >/dev/null 2>&1; do sleep 30; done
printf '%s  triage sweep ended, starting extraction\n' "$(date '+%H:%M:%S')" >> "$LOG"
exec ./scripts/extract-sweep.sh 20 400
