#!/bin/sh
# One line of truth about the two runners, for a monitor to poll.
#
# Detection is by exact command line rather than a pattern, because a pattern
# broad enough to find "extract-sweep.sh" also matches any watcher whose own
# command mentions it - which made a monitor report a phase as running that had
# not started, and would have kept it from ever reporting completion.
set -u
cd "$(dirname "$0")/.." || exit 1
DB="${ALLINT_DB:-./data/allint.db}"

# Match the script by name at a path boundary, not by how it was invoked. A
# chain script execs its successor by absolute path while a shell starts it by
# relative path, and anchoring on one form made a running process invisible -
# which had a monitor report the work finished while it was still going.
# Anchoring on "scripts/NAME.sh" still excludes any watcher that merely mentions
# the name, which was the earlier failure in the other direction.
alive() { ps -eo command | grep -qE "^/bin/sh .*scripts/$1\.sh( |$)" && echo y || echo n; }
q() { node -e "const d=require('better-sqlite3')('$DB');console.log(d.prepare(\"$1\").get().c)" 2>/dev/null || echo -1; }

printf 'triage=%s extract=%s chain=%s unread=%s pending=%s events=%s\n' \
  "$(alive triage-sweep)" "$(alive extract-sweep)" "$(alive after-triage-extract)" \
  "$(q 'select count(*) c from items where triaged_at is null')" \
  "$(q "select count(*) c from items where triage_verdict is not null and triage_verdict!='mundane' and extracted_at is null and extraction_error is null")" \
  "$(q 'select count(*) c from events')"
