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
npx tsx src/cli/index.ts run       # ingest → extract → link → thread → brief
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

Everything else in the system is verified: 46 tests cover parsing, entity
resolution, the detectors and the scoring, all against recorded fixtures.

---

## Commands

| Command | What it does | Costs API tokens |
|---|---|---|
| `demo` | Seed a synthetic corpus and run detectors | no |
| `init` | Create the database, load the registry | no |
| `sources` / `sources:check [--fix]` | List / probe sources | no |
| `ingest [--all] [-s id...]` | Fetch new items from due sources | no |
| `extract [-l n]` | Items → structured events | **yes** |
| `link [-H] [-d days]` | Find connections (`-H` adds hypotheses) | only with `-H` |
| `threads:update` | Assign events to storylines, resynthesize | **yes** |
| `brief [-w hours]` | Write the brief | **yes** |
| `run` | The whole pipeline | **yes** |
| `threads` / `thread <id>` | List / read storylines | no |
| `connections [-b basis]` | Browse links found | no |
| `verdict <id> <sound\|coincidence\|wrong>` | Record your judgement | no |
| `entity <name>` / `entities` | What a party has been involved in | no |
| `search <query>` | Full-text over everything ingested | no |
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

**You grade it.** `verdict` records whether a link was sound, coincidence or
wrong. That is the ground truth for tuning the detectors, and the honest answer
to "how well does this work" once you have run it for a while.

---

## Architecture

```
sources/     fetch + parse            → Item     raw material, as published
pipeline/    extract (LLM, schema'd)  → Event    dated assertion, typed parties
             detectors/ (pure SQL)    → Connection  the checkable half
             link (LLM, capped)       → Connection  the speculative half
             threads (LLM)            → Thread   persistent storyline
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

### Known limitation: congressional trade detail

The House Clerk's disclosure index gives you *who* filed a periodic transaction
report and *when*. It does not give you the ticker, direction or size - those
are in per-filing PDFs, many of them scans without a text layer.

So `trade-then-award` currently runs on SEC Form 4 (structured and complete for
corporate insiders) and on anything you import yourself. **Do not read the
absence of congressional trade detail as an absence of congressional trading.**
Closing this gap - PDF parsing, or an import path for data parsed elsewhere -
is the highest-value next piece of work.

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

Built: the core engine and the CLI. Verified: 46 tests over parsing, entity
resolution, detectors and scoring. Unverified: the feed URLs, which need
`sources:check --fix` on a networked machine.

Next, in order:

1. **`sources:check --fix`**, then prune what fails. Nothing downstream is
   worth much until the inputs are real.
2. **Congressional trade detail** - the gap described above.
3. **Web app** - Next.js over the same SQLite/libSQL store: storyline pages,
   entity pages, the connection graph, search.
4. **Forecasting** - the schema and Brier scoring are already in
   (`forecasts` table, `resolveForecast`, `calibration`). What's missing is
   question generation from live threads and the fetch that anchors each
   estimate to a matching Polymarket/Kalshi/Metaculus price. Every forecast
   carries a resolution criterion and gets scored, because a forecast nobody
   scores is just an opinion with a number on it.

---

## Development

```bash
npm run typecheck
npm run test
npm run build
npx tsx src/cli/index.ts <command>   # run without building
```
