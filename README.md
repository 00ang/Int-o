# throughline

A personal intelligence system for politics, geopolitics, business and tech.

It ingests primary records and credible press, extracts structured events,
links them into **connections** and **storylines**, and writes you a brief. The
point is not to read more news. It is to follow the plot.

---

## The problem this is built around

Two kinds of connection are worth knowing about, and they need completely
different machinery:

**A disclosed stock position in a defense contractor, followed by that
contractor winning a federal contract.** This is a join over structured public
records: an insider filing on one side, an award record on the other, matched
on company identity inside a date window. It is checkable. It is either in the
data or it is not.

**A beef-price policy announcement, and a change in how wild horses are
gathered and sold.** This is a chain of consequence through land use, grazing
allotments and slaughter capacity. No single record contains it.

The first kind is what deterministic detectors do. The second kind is what a
language model can propose but must never assert. Keeping those two apart is
the central design commitment of this system - see [Honest by
construction](#honest-by-construction).

---

## Quickstart

```bash
npm install
npm run build

export THROUGHLINE_DB=./data/throughline.db
export THROUGHLINE_CONTACT_EMAIL=you@example.com   # required by SEC and others
export ANTHROPIC_API_KEY=sk-ant-...                # extraction, threads, brief

npx tsx src/cli/index.ts demo      # see it work: no key, no network
npx tsx src/cli/index.ts init      # create the DB, load 79 sources
npx tsx src/cli/index.ts sources:check --fix   # ← do this first, see below
npx tsx src/cli/index.ts run       # ingest → triage → extract → link → thread → brief
```

`demo` seeds a synthetic corpus and runs the detectors. It needs nothing and
proves the engine works in about a second.

### Read this before trusting the source list

**The 79 feed URLs in `src/sources/registry.ts` have not been confirmed against
their live hosts.** This was built in an environment with all outbound HTTP
blocked by policy, so every entry ships `verified: false`.

`sources:check --fix` probes all of them, marks the ones that answer, and
disables the rest. Run it on your own machine before your first real ingest.
Expect a meaningful number to fail - feed URLs rot constantly, and the wire
services in particular move theirs.

Everything else in the system is verified: 162 tests cover parsing, entity
resolution, the detectors, the scoring, the trade import and the forecasting
loop, all against recorded fixtures.

---

## Commands

| Command | What it does | Costs API tokens |
|---|---|---|
| `demo` | Seed a synthetic corpus and run detectors | no |
| `init` | Create the database, load the registry | no |
| `sources` / `sources:check [--fix]` | List / probe sources | no |
| `ingest [--all] [-s id...]` | Fetch new items from due sources | no |
| `import:trades <file> [-n]` | Import disclosed trades from CSV/JSON | no |
| `triage [-l n]` | Judge what deserves attention | **yes**, cheaply |
| `queue [--notable] [--angles]` | The reading list: what survived triage | no |
| `investigate <id> [-H]` | Take a second look at one item | only with `-H` |
| `extract [-l n]` | Triaged items → structured events | **yes** |
| `link [-H] [-d days]` | Find connections (`-H` adds hypotheses) | only with `-H` |
| `threads:update` | Assign events to storylines, resynthesize | **yes** |
| `brief [-w hours]` | Write the brief | **yes** |
| `run` | The whole pipeline | **yes** |
| `threads` / `thread <id>` | List / read storylines | no |
| `connections [-b basis]` | Browse links found | no |
| `trades [--late] [-f name]` | Browse disclosed trades and late filings | no |
| `verdict <id> <sound\|coincidence\|wrong>` | Record your judgement | no |
| `entity <name>` / `entities` | What a party has been involved in | no |
| `search <query>` | Full-text over everything ingested | no |
| `forecast [-t thread]` | Propose scoreable forecasts from storylines | **yes** |
| `forecast:anchor` | Match forecasts to ingested market prices | no |
| `forecasts [--open\|--due\|--resolved]` | List forecasts | no |
| `forecast:show <id>` | Read one in full | no |
| `forecast:resolve <id> <yes\|no\|ambiguous>` | Record the outcome and score it | no |
| `calibration` | How well the forecasts have scored | no |
| `brief:last`, `stats` | Read cached brief, corpus size | no |

---

## Honest by construction

A system that finds hidden connections in the news is one design mistake away
from being a conspiracy generator. These are the structural guards, not
guidelines but properties of the schema:

**Every connection records how it was found.** The `basis` column is one of:

- `deterministic` - a join over structured records on a shared canonical party
  and a date window. No model involved. The confidence score is computed from
  source tier, assertion strength and timing tightness; a model never writes it.
- `entity-overlap` - the same party appears in two events from two independent
  sources, close in time. Scored low on purpose. It means "these concern the
  same party" and nothing more.
- `hypothesis` - proposed by a language model. Capped at 0.7 so it can never
  outrank a deterministic finding, presented in its own section of the brief,
  and **required to carry a falsifier**: a specific observation that would show
  the link is not real. No falsifier, no hypothesis.

**Every event records how firmly its source establishes it** - `documented`
(a filing or official record), `reported` (a newsroom asserting verified fact),
`alleged` (a claim by a party to a dispute), `speculated` (analysis presented
as such). Weak assertions discount every connection built on them.

**Nothing is asserted that isn't traceable.** Connections reference events,
events reference items, items carry the source and the URL. The brief's
markdown is assembled in code, not written by the model, so a claim cannot
appear in it without a link behind it.

**The model is told to decline.** The hypothesis prompt says shared sector and
proximity in time are not connections, that most co-occurring events are
unrelated, that an empty list is the correct answer more often than not, and
that it may note a pattern is consistent with coordination but may not assert
coordination happened.

**Triage filters, it does not accuse.** Every item is judged before anything
else is spent on it, and the ceiling of that judgement is "worth a look" - a
named thing to check, never a conclusion. Nothing downstream runs on its own
initiative: `investigate` exists because a person pressed it. The system
surfaces, you choose, and only then does it go digging. That ordering is what
keeps a tool that looks for hidden connections from being a machine that
manufactures them.

**Scale is not evidence.** Triage is explicitly told that a disaster with a
thousand dead is mundane for these purposes, because it is exactly what it
appears to be, and that a famous name or a contentious topic is not a reason to
look twice. The axis is whether money or power did something the piece does not
fully explain - not whether the story is big.

**You grade it.** `verdict` records whether a link was sound, coincidence or
wrong. That is the ground truth for tuning the detectors, and the honest answer
to "how well does this work" once you have run it for a while.

---

## Architecture

```
sources/     fetch + parse            → Item     raw material, as published
pipeline/    triage (LLM, cheap)      → verdict  is this worth attention at all
             extract (LLM, schema'd)  → Event    dated assertion, typed parties
             detectors/ (pure SQL)    → Connection  the checkable half
             link (LLM, capped)       → Connection  the speculative half
             threads (LLM)            → Thread   persistent storyline
             forecast (LLM proposes,  → Forecast scored against reality
                       code validates)
             brief (code + LLM prose) → Brief
```

**Storage** is SQLite (`better-sqlite3`) with FTS5 search. Local-first, no
infrastructure, and content-addressed ids make re-ingestion idempotent - which
matters because feeds re-serve their whole window on every poll. For the web
app, Turso/libSQL is a drop-in.

**Detectors** live in `src/pipeline/detectors/rules.ts` as declarative pair
rules: *event of type X involving party P, followed within N days by event of
type Y involving the same P*. Adding a pattern is adding an entry there, and
the join is on canonical entity identity - which is why `slugifyEntity` strips
corporate suffixes so `Lockheed Martin Corp.` and `Lockheed Martin` are one
party, not two.

**Model calls** all go through `src/core/llm.ts` and are constrained by Zod
schemas via structured outputs. Nothing downstream ever parses free text out of
a model response.

### Sources

79 across five credibility tiers, weighted by evidentiary value:

- **primary** (30) - Federal Register, USASpending awards, DoD daily contract
  announcements, SEC EDGAR (Form 4, 8-K), House STOCK Act disclosures,
  Congress.gov, OFAC actions, Fed/ECB, DOJ/FTC, CourtListener, GAO, EUR-Lex,
  UN/NATO/WTO/IMF, prediction markets
- **wire** (9) - Reuters, AP, AFP-adjacent, Al Jazeera, DW, France 24, Kyodo,
  plus TASS and Xinhua carried explicitly as state outlets
- **outlet** (19) - FT, Economist, Guardian, BBC, NYT, WaPo, Politico, Axios,
  Semafor, Nikkei Asia, SCMP, Le Monde, Spiegel, Haaretz, The Hindu, Rest of
  World
- **research** (19) - Lawfare, War on the Rocks, ISW, CSIS, Carnegie,
  Brookings, Chatham House, PIIE, Bruegel, ECFR, RUSI, NBER, VoxEU, arXiv,
  OCCRP, ICIJ, Bellingcat, Foreign Affairs

Each carries editorial origin and lean - not to down-rank anyone, but so a
storyline carried entirely by outlets sharing one vantage can be flagged as
such.

### Congressional trade detail

The House Clerk's disclosure index gives you *who* filed a periodic transaction
report and *when*. It does not give you the ticker, direction or size - those
are in per-filing PDFs, many of them scans without a text layer. That is why
`src/sources/stock-act.ts` can only produce "member filed a PTR" items.

`import:trades` closes the gap from the other end. Whatever parsed those PDFs -
a community dataset, a vendor API, your own script - hand the result to it:

```bash
throughline import:trades house-trades.json --dry-run   # see what it will do
throughline import:trades house-trades.json
throughline link                                        # now it has trades to join
throughline trades --late                               # who filed past the deadline
```

CSV or JSON, no mapping file. Column names are recognised across the shapes
that actually exist - `representative`/`senator`/`member`, `transaction_date`,
`disclosure_date`, `ticker`, `type`, `amount` - so the public
house-stock-watcher and senate-stock-watcher dumps, the common vendor exports
and a hand-rolled spreadsheet all import as-is. `--dry-run` prints the column
mapping and the rows it would drop before writing anything.

Each trade becomes a `securities-trade` event with the filer as `actor` and the
issuer as `target`, which is the exact shape `trade-then-award` already looks
for. So importing congressional trades makes every existing detector work on
them, with no change to the rules.

**What it will not do.** Disclosures report *bands* ("$1,001 - $15,000"), so the
event carries the band's lower bound and both ends go to tags. There is no
midpoint anywhere: a midpoint reads as a measurement and it is not one. Rows it
cannot date or attribute are dropped and counted, not defaulted - including the
typo'd years the public House dataset contains, because a trade dated 9 AD
matches every detector window there is.

**The disclosure lag.** The interval between executing a trade and filing it is
the one number here that is a fact rather than an inference, and the STOCK Act
gives it a bright line: a periodic transaction report is due within 45 days.
Every imported trade carries `disclosure-lag:<n>`; one past that line carries
`late-filing` and shows up in `trades --late`. Cheapest real signal in the
dataset.

Still open: parsing the PTR PDFs directly, so no external dataset is needed.
**Do not read the absence of congressional trade detail as an absence of
congressional trading.**

---

## Forecasting

The rest of this system reconstructs what happened. This is the only part that
says what will happen, so it carries the strictest rule in the codebase: every
forecast is scored.

```bash
throughline forecast          # propose questions from active storylines
throughline forecast:anchor   # put a market price beside each one
throughline forecasts --due   # what is past its date and unscored
throughline forecast:resolve <id> yes
throughline calibration       # how you have actually done
```

**Questions must be gradeable or they are not stored.** A proposal is dropped
if it resolves in the past, resolves so far out that scoring it teaches you
nothing in time, sits at a probability that makes it a statement rather than a
forecast, or arrives without a resolution criterion or a reference class. The
drop reasons are printed, because a silent drop rate is how a forecasting loop
quietly stops forecasting.

**Anchoring is code, not a model call.** Deciding that our question and a
market's question are the same question is exactly the judgement that reads
fine in prose and is wrong a third of the time, and a forecast anchored to the
wrong market corrupts the one number meant to be an independent check on ours.
So `forecast:anchor` is weighted token overlap against the markets already
ingested, with a floor and a close-date check, and it declines rather than
reaches. Unmatched is a normal outcome and is reported as one.

**The market price sits beside our estimate, never blended into it.** Averaging
the two would erase the only thing the anchor is for: seeing where we disagree
with the crowd, and finding out later who was right. `calibration` scores both.

**Calibration is a curve, not a number.** The mean Brier says how good the
forecasts were; the bucket table says *how* they were wrong, which is the part
you can act on:

```
said        n   we said   happened
0%-20%       1       10%         0%
20%-40%      3       30%        33%
40%-60%      2       45%        50%
60%-80%      4       70%        75%
80%-100%     2       90%        50%     ← overconfident up here
```

---

## Cost

`extract` makes one call per item; `threads:update` and `brief` make a handful
per run. Defaults are `claude-opus-5` at medium effort, with the stable prompt
prefix cached.

Ingesting a few hundred items a day, this is dollars per day, not cents. Both
knobs are environment variables:

```bash
export THROUGHLINE_MODEL=claude-sonnet-5   # materially cheaper per item
export THROUGHLINE_EXTRACT_LIMIT=40        # cap items per extraction run
```

Extraction is mechanical work over short inputs and degrades gracefully to a
smaller model. Brief writing and hypothesis generation are where capability
actually shows.

---

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `THROUGHLINE_DB` | Database path | `./data/throughline.db` |
| `THROUGHLINE_CONTACT_EMAIL` | Identifies you in the User-Agent | none |
| `ANTHROPIC_API_KEY` | Extraction, threads, brief | none |
| `ANTHROPIC_WORKSPACE_ID` | Only for an identity-linked key, which the API rejects without it | none |
| `THROUGHLINE_TRIAGE_MODEL` | Model for triage, which reads everything | `claude-haiku-4-5-20251001` |
| `THROUGHLINE_TRIAGE_BATCH_SIZE` | Items judged per call | 12 |
| `THROUGHLINE_TRIAGE_LIMIT` | Items per triage run | 120 |
| `THROUGHLINE_MODEL` | Model id | `claude-opus-5` |
| `THROUGHLINE_EXTRACT_LIMIT` | Items per extraction run | 40 |
| `THROUGHLINE_HOST_DELAY_MS` | Politeness delay per host | 400 |
| `CONGRESS_GOV_API_KEY` | Congress.gov (free at api.data.gov) | none |
| `COURTLISTENER_API_TOKEN` | CourtListener | none |

Set `THROUGHLINE_CONTACT_EMAIL`. SEC EDGAR and several other government hosts
throttle or refuse traffic that does not identify itself, and doing so is a
condition of their access policies.

---

## Status and what's next

Built: the core engine, the CLI, the trade import path and the forecasting
loop. Verified: 162 tests over parsing, entity resolution, detectors, scoring,
import, market matching and calibration. Unverified: the feed URLs, which need
`sources:check --fix` on a networked machine.

Next, in order:

1. **`sources:check --fix`**, then prune what fails. Nothing downstream is
   worth much until the inputs are real.
2. **Web app** - Next.js over the same SQLite/libSQL store: storyline pages,
   entity pages, the connection graph, search.
3. **PTR PDF parsing**, so congressional trade detail needs no external
   dataset. `import:trades` covers this today from any source that has already
   parsed them.
4. **Forecast generation against live threads.** The loop is built and tested,
   but `forecast` has never been run against a real corpus with an API key -
   the prompt's judgement about what makes a scoreable question is the part
   that needs contact with reality.

---

## Development

```bash
npm run typecheck
npm run test
npm run build
npx tsx src/cli/index.ts <command>   # run without building
```
