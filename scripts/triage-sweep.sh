#!/bin/sh
# Work through the triage backlog on the subscription backend.
#
# The CLI shares a rate limit with interactive sessions, so a long sweep will be
# refused periodically no matter when it starts. This retries rather than
# failing: a refusal costs nothing and no item is retired over one, so waiting
# is always the right response.
#
# Progress lives in the database, not here. Every batch that succeeds is
# committed before the next begins, so killing this at any point loses nothing
# and restarting it simply continues.
#
#   scripts/triage-sweep.sh [batch-size] [max-batches]

set -u
cd "$(dirname "$0")/.." || exit 1

BATCH="${1:-24}"
MAX="${2:-200}"
LOG="${ALLINT_SWEEP_LOG:-/tmp/allint-triage-sweep.log}"

set -a
# shellcheck disable=SC1091
. ./.env
set +a
# The subscription login is only used when no API key is present.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_WORKSPACE_ID ANTHROPIC_BASE_URL

remaining() {
  node -e "const d=require('better-sqlite3')('${ALLINT_DB:-./data/allint.db}');console.log(d.prepare('select count(*) c from items where triaged_at is null').get().c)" 2>/dev/null || echo 0
}

printf '%s  sweep starting, %s items unread, batches of %s\n' \
  "$(date '+%H:%M:%S')" "$(remaining)" "$BATCH" >> "$LOG"

backoff=60
i=0
while [ "$i" -lt "$MAX" ]; do
  i=$((i + 1))
  left="$(remaining)"
  if [ "$left" -le 0 ]; then
    printf '%s  backlog clear, stopping\n' "$(date '+%H:%M:%S')" >> "$LOG"
    break
  fi

  out="$(npx tsx src/cli/index.ts triage -l "$BATCH" 2>&1)"
  if printf '%s' "$out" | grep -qiE 'session limit|rate limit|usage limit|exited 1'; then
    printf '%s  refused, waiting %ss (%s unread)\n' "$(date '+%H:%M:%S')" "$backoff" "$left" >> "$LOG"
    sleep "$backoff"
    # Back off up to ten minutes; a session limit lasts longer than a burst one.
    backoff=$((backoff * 2))
    [ "$backoff" -gt 600 ] && backoff=600
    i=$((i - 1))
    continue
  fi

  backoff=60
  printf '%s  %s\n' "$(date '+%H:%M:%S')" \
    "$(printf '%s' "$out" | grep -E 'items judged|kept\.' | tr '\n' ' ')" >> "$LOG"
done

printf '%s  sweep finished, %s items still unread\n' "$(date '+%H:%M:%S')" "$(remaining)" >> "$LOG"
