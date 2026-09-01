#!/bin/sh
# Write dossiers until the queue of worthwhile parties is empty.
#
# buildProfiles already stops a batch after three consecutive failures, because
# once the backend is refusing the rest of the batch will refuse too. This wraps
# that: a refused batch is waited out and retried rather than treated as the end
# of the work. Each dossier commits on its own, so stopping this at any point
# loses nothing and restarting continues.
#
#   scripts/profile-sweep.sh [batch-size] [max-rounds]
set -u
cd "$(dirname "$0")/.." || exit 1
BATCH="${1:-10}"
MAX="${2:-60}"
LOG="${ALLINT_PROFILE_LOG:-/tmp/allint-profile-sweep.log}"
DB="${ALLINT_DB:-./data/allint.db}"

written() {
  node -e "const d=require('better-sqlite3')('$DB');console.log(d.prepare('select count(*) c from entity_profiles').get().c)" 2>/dev/null || echo 0
}

printf '%s  dossier sweep starting, %s on file\n' "$(date '+%H:%M:%S')" "$(written)" >> "$LOG"
backoff=60
round=0
while [ "$round" -lt "$MAX" ]; do
  round=$((round + 1))
  before="$(written)"
  out="$(./bin/all-int profile -l "$BATCH" 2>&1)"
  after="$(written)"

  if [ "$after" -gt "$before" ]; then
    backoff=60
    printf '%s  +%s dossiers (%s on file)\n' "$(date '+%H:%M:%S')" "$((after - before))" "$after" >> "$LOG"
    continue
  fi

  # Nothing written. Either the queue is empty, or the backend refused.
  if printf '%s' "$out" | grep -qiE 'session limit|rate limit|credit balance|exited 1'; then
    printf '%s  refused, waiting %ss (%s on file)\n' "$(date '+%H:%M:%S')" "$backoff" "$after" >> "$LOG"
    sleep "$backoff"
    backoff=$((backoff * 2))
    [ "$backoff" -gt 600 ] && backoff=600
    round=$((round - 1))
    continue
  fi

  printf '%s  queue empty, stopping (%s on file)\n' "$(date '+%H:%M:%S')" "$after" >> "$LOG"
  break
done
printf '%s  dossier sweep finished, %s on file\n' "$(date '+%H:%M:%S')" "$(written)" >> "$LOG"
