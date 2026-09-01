#!/bin/sh
# Wait for the triage sweep to finish, then write dossiers.
#
# Chained rather than concurrent: both want the same rate limit, and triage is
# nearly done, so letting it finish first gets the reading queue complete before
# anything slower starts.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/allint-profile-sweep.log
while pgrep -f triage-sweep.sh >/dev/null 2>&1; do sleep 30; done
printf '%s  triage finished, starting dossiers\n' "$(date '+%H:%M:%S')" >> "$LOG"
exec ./scripts/profile-sweep.sh 10 60
