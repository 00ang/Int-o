#!/bin/sh
# Extract every retained item, waiting out rate limits.
#
# Extraction is a different cost shape from triage. Triage judges twelve items
# in one call; extraction is one call per item, because each one returns a
# distinct set of dated, attributed events and batching them would blur exactly
# the attribution the rest of the system depends on. So this is slower per item
# and there is no way around that.
#
# The engine already stops a batch after three consecutive infrastructure
# failures, and it does not retire an item over one. This loop wraps that: when
# a batch comes back having done nothing, it waits and tries again rather than
# treating a rate limit as the end of the work.
#
#   scripts/extract-sweep.sh [batch-size] [max-rounds]

set -u
cd "$(dirname "$0")/.." || exit 1

BATCH="${1:-20}"
MAX="${2:-400}"
LOG="${ALLINT_SWEEP_LOG:-/tmp/allint-extract-sweep.log}"

set -a
# shellcheck disable=SC1091
. ./.env
set +a
# The subscription login is only used when no API key is present.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_WORKSPACE_ID ANTHROPIC_BASE_URL

DB="${ALLINT_DB:-./data/allint.db}"

pending() {
  node -e "const d=require('better-sqlite3')('$DB');console.log(d.prepare(\"select count(*) c from items where triage_verdict is not null and triage_verdict!='mundane' and extracted_at is null and extraction_error is null\").get().c)" 2>/dev/null || echo 0
}
events() {
  node -e "const d=require('better-sqlite3')('$DB');console.log(d.prepare('select count(*) c from events').get().c)" 2>/dev/null || echo 0
}

printf '%s  extraction starting, %s retained items pending, %s events on file\n' \
  "$(date '+%H:%M:%S')" "$(pending)" "$(events)" >> "$LOG"

backoff=60
round=0
while [ "$round" -lt "$MAX" ]; do
  round=$((round + 1))
  left="$(pending)"
  if [ "$left" -le 0 ]; then
    printf '%s  nothing left to extract, stopping\n' "$(date '+%H:%M:%S')" >> "$LOG"
    break
  fi

  before="$(events)"
  out="$(npx tsx src/cli/index.ts extract -l "$BATCH" 2>&1)"
  after="$(events)"

  if [ "$after" -gt "$before" ]; then
    backoff=60
    printf '%s  +%s events (%s pending)\n' \
      "$(date '+%H:%M:%S')" "$((after - before))" "$(pending)" >> "$LOG"
    continue
  fi

  # No events written. Either the API is refusing, or this batch genuinely had
  # nothing to extract - the pending count tells them apart.
  if [ "$(pending)" -lt "$left" ]; then
    printf '%s  batch yielded no events but consumed items (%s pending)\n' \
      "$(date '+%H:%M:%S')" "$(pending)" >> "$LOG"
    continue
  fi

  printf '%s  refused, waiting %ss (%s pending) %s\n' \
    "$(date '+%H:%M:%S')" "$backoff" "$left" \
    "$(printf '%s' "$out" | grep -oiE 'session limit|rate limit|credit balance|exited 1' | head -1)" >> "$LOG"
  sleep "$backoff"
  backoff=$((backoff * 2))
  [ "$backoff" -gt 600 ] && backoff=600
done

printf '%s  extraction finished, %s pending, %s events on file\n' \
  "$(date '+%H:%M:%S')" "$(pending)" "$(events)" >> "$LOG"

# The map is wired from events, so it is stale the moment extraction adds any.
npx tsx src/cli/index.ts graph:build >> "$LOG" 2>&1
printf '%s  association map rebuilt\n' "$(date '+%H:%M:%S')" >> "$LOG"
