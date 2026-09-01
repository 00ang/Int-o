# all-int

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
npm link          # makes `all-int` available anywhere

cp .env.example .env    # then fill in ANTHROPIC_API_KEY, or set
                        # ALLINT_LLM_PROVIDER=claude-cli to use a subscription

all-int demo      # see it work: no key, no network
all-int init      # create the DB, load the source registry
all-int sources:check --fix   # confirm which feeds answer - do this first
all-int run       # ingest -> triage -> extract -> link -> thread -> brief
```

The `all-int` wrapper loads `.env` itself and resolves the project from its own
location, so it works from any directory. That matters more than it sounds: the
CLI reads `process.env` directly and carries no dotenv, so invoking it without
the wrapper runs with no API key and writes to whatever `./data/allint.db`
resolves to from wherever you were standing.

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
| `ptr:fetch [-y year] [-l n]` | Read congressional PTR filing PDFs and import the trades | no |
| `profile [-l n]` | Write background dossiers on the main parties | **yes** |
| `dossier <name>` | Read one party's dossier | no |
| `graph:build` | Wire the association map from the events on file | no |
| `activate <id> [-H hops]` | Fire the map from one item and see what lights up | no |
| `synthesize <id>` | Fire the map, then judge the chains that lit | **yes** |
| `assess <id>` | Both tracks - records and background - then reconcile | **yes**, 3 calls |
| `bodies [-l n]` | Fetch full article text for retained items | no |
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

## Article bodies

Feeds ship a headline and a blurb. Before `bodies` the corpus held 2,577 items
of headline against 534 with real text, which meant triage was guessing what a
story hid from its headline and extraction was pulling parties and roles out of
one sentence. Thin events, a sparse map, and angles that read as vague because
there was nothing underneath them to be specific about - all of it came from
there.

`bodies` fetches the article behind a retained item's own link, keeps the text
if it plausibly is one, and gives up quietly otherwise. It is not a general
scraper and it will not defeat a paywall: roughly a quarter of attempts come
back blocked, which is reported as a coverage figure rather than retried. The
guard that matters is not against an empty body but against a plausible one - a
consent wall is several hundred words of real English, and storing it would be
worse than storing nothing because everything downstream would treat it as the
article.

An item whose body arrives after extraction has already run is reopened, since
the text it was judged on has changed.

## Party dossiers

Extraction may not add context the text does not carry. That rule is what makes
the events trustworthy, and it is also why a party was nothing but a name with a
mention count. An event involving a name has no weight. The same event involving
a party you know spent a decade on the board of the counterparty is information.

`profile` writes a dossier per party: what they are, bodies they have been
attached to, prior episodes that change how a new event involving them reads,
and what they are positioned to do. `dossier <name>` reads one.

**Every claim carries its own provenance**, because this is the one stage where
outside knowledge is the point rather than the hazard:

- `corpus` - a record here supports it, and you can check it here.
- `recalled` - the model asserts it from training. Plausible, unverified,
  possibly out of date. Most background is this, and it is labelled rather than
  dressed up as a record.
- `inferred` - follows from the other claims.

**Capabilities are the possibility axis**, and they are deliberately separate
from history. A denial is not disproof; the useful question about a denied thing
is whether it is within reach for this party and what it would take. So every
capability names the resource or approval required and the trace it would leave
in the public record if they were pursuing it. That keeps a possibility a
question someone can go and check, rather than an accusation.

A dossier on a party the model does not reliably know comes back `thin` and
nearly empty. A padded dossier is worse than none, because everything
downstream treats it as knowledge.

## Two tracks, then a reconciliation

`assess <item>` is the full read, and its shape is the point.

**The evidence track** reads the records: chains of events connecting this story
to parties it never names, and judges which chains are a mechanism rather than
coincidence. It sees no dossiers.

**The background track** reads the parties: their affiliations, prior episodes
and capabilities, and what their position would lead you to expect around this
subject. It sees no connecting records at all.

They run concurrently and neither can see the other's material. That separation
is the design. A model handed records and background together finds what the
background primed it to find, and its agreement with itself proves nothing. Kept
apart, the two tracks can reach the same party for different reasons - and
*that* convergence is the strongest thing this system can produce.

**The reconciliation** sees only the two conclusions, never their inputs, so it
cannot re-argue either read. It can only compare them, and assign standing:

| standing | meaning |
|---|---|
| `corroborated` | both tracks reached it independently, on different grounds. Ranked first. |
| `records-only` | the records support it; background neither helps nor hurts. |
| `background-only` | background suggests it; nothing in the corpus supports it yet. Weakest, and labelled as such. |
| `contested` | the tracks point different ways. Not resolved by picking one - the disagreement is the finding. |

Confidence is bounded by construction. A background lead caps at 0.55, below
anything built on records this corpus holds, because background is mostly
recalled and unverified. A reconciled finding caps at 0.7, like every other
model proposal here. Empty findings is a correct and common outcome, and the
assessment is expected to say "there is nothing here" when that is true.

Three model calls where the single-track `synthesize` made one. That is the
price of cross-checking rather than confirming.

## The association map

The detectors ask whether two records join on a shared party inside a date
window. That finds the checkable cases and misses everything else, because a
join can only see what already sits in one row.

The map sees further. Parties become nodes; the events they share become
weighted edges; and a question can then travel. `graph:build` wires it from
three kinds of shared context, in descending strength: two parties named in one
event, two parties in different events of one document, two parties in one
storyline. The last is what gives the map any reach - without it the graph is a
pile of two-party cliques with no bridges.

`activate <item>` fires it. The story's own parties are seeded with energy,
which travels along edges, attenuating at each hop, until it falls below a
threshold. What is still lit at the end is what the corpus associates with the
story.

**The far half is the point.** A party one hop out was named alongside the seed,
which a join already finds. A party lit at two or three hops never appeared
beside it anywhere, and that is the shape no query over events can return.

Three things stop the map lighting up uniformly, which is the failure mode that
makes a graph like this useless:

- **Containers do not relay.** A country or a place sits between any two parties
  in a corpus of national records. They light up and are reported; they cannot
  be the reason something else lit.
- **Specificity attenuates.** Energy through a node is scaled by how connected
  it is. A path through a party with three associates is informative; the same
  path through one with forty is a fact about the corpus, not about the story.
- **Unnamed parties do not relay.** "An unnamed private company" is a real thing
  to have captured - it is the shape of the gap - but wiring energy through it
  would join every story that withheld a name to every other one.

`synthesize <item>` fires the map and then reads the actual events along each
chain, asking whether any amounts to a mechanism. The model never sees the
energy scores - a number it did not compute is a number it will rationalise -
only the story, the party that lit up, and the chain of records between them.
Every lead it returns must name a mechanism, state what would confirm it, and
carry a falsifier; confidence is capped at 0.7 so a proposal from a statistical
procedure can never outrank a deterministic finding. Returning nothing is the
expected answer and usually the right one.

**Activation is not evidence.** It says the map has a weighted path, and a
weighted path through a co-occurrence graph is exactly as innocent as
co-occurrence. Two parties can light each other up through a shared regulator
and a busy week. That is why every activated party carries the chain that
reached it: so the reason is inspectable, and so it can be dismissed.

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
all-int import:trades house-trades.json --dry-run   # see what it will do
all-int import:trades house-trades.json
all-int link                                        # now it has trades to join
all-int trades --late                               # who filed past the deadline
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
all-int forecast          # propose questions from active storylines
all-int forecast:anchor   # put a market price beside each one
all-int forecasts --due   # what is past its date and unscored
all-int forecast:resolve <id> yes
all-int calibration       # how you have actually done
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

## Running without API credit

The API bills per token against a credit balance. Most of this system never
touches it:

| Free, always | |
|---|---|
| `ingest`, `sources:check`, `bodies` | fetching |
| `ptr:fetch`, `import:trades` | congressional trades, including the PDF parsing |
| `graph:build`, `activate` | the association map and firing it |
| `link` without `-H` | the deterministic detectors |
| `search`, `queue`, `entity`, `trades`, `threads`, `stats`, `calibration` | reading |
| the entire web app | including the map and every chart |

Only judgement costs anything: `triage`, `extract`, `synthesize`,
`threads:update`, `brief`, `forecast`, and `link -H`.

For those, set `ALLINT_LLM_PROVIDER=claude-cli` and they run through a Claude
Code subscription instead of a credit balance - the same models, nothing billed
per token. The trade is a shared rate limit: the CLI competes with your
interactive sessions and will refuse when the API would not. Those refusals are
transient by construction and no item is retired over one.

One thing genuinely differs. The API constrains generation to the schema, so
malformed output is impossible. The CLI returns text, so the schema becomes a
check applied afterwards rather than a guarantee applied during - every response
is still parsed and validated against the same Zod schema, and a response that
fails is an error rather than a partial result. The contract at the boundary is
identical; only where it is enforced has moved.

**Local models were tried and are not good enough for the judgement stages.**
`qwen3:4b` marked every item notable, returned lowercased headlines as topics,
and produced "insider trading or regulatory violation" as an angle - an
accusation, which the design forbids outright. `mistral:7b` discriminated better
but returned category labels ("Economy", "Finance") where the prompt demands
specifics, called a flood notable when the prompt names disasters as mundane,
missed the regulatory item that was the actual case, and took 29 seconds an
item. Triage is a judgement about what a text is not saying; that is not a task
a 4B or 7B model does.

## Cost

`extract` makes one call per item; `threads:update` and `brief` make a handful
per run. Defaults are `claude-opus-5` at medium effort, with the stable prompt
prefix cached.

Ingesting a few hundred items a day, this is dollars per day, not cents. Both
knobs are environment variables:

```bash
export ALLINT_MODEL=claude-sonnet-5   # materially cheaper per item
export ALLINT_EXTRACT_LIMIT=40        # cap items per extraction run
```

Extraction is mechanical work over short inputs and degrades gracefully to a
smaller model. Brief writing and hypothesis generation are where capability
actually shows.

---

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `ALLINT_DB` | Database path | `./data/allint.db` |
| `ALLINT_CONTACT_EMAIL` | Identifies you in the User-Agent | none |
| `ANTHROPIC_API_KEY` | Extraction, threads, brief | none |
| `ANTHROPIC_WORKSPACE_ID` | Only for an identity-linked key, which the API rejects without it | none |
| `ALLINT_TRIAGE_MODEL` | Model for triage, which reads everything | `claude-haiku-4-5-20251001` |
| `ALLINT_TRIAGE_BATCH_SIZE` | Items judged per call | 12 |
| `ALLINT_TRIAGE_LIMIT` | Items per triage run | 120 |
| `ALLINT_MODEL` | Model id | `claude-opus-5` |
| `ALLINT_EXTRACT_LIMIT` | Items per extraction run | 40 |
| `ALLINT_HOST_DELAY_MS` | Politeness delay per host | 400 |
| `CONGRESS_GOV_API_KEY` | Congress.gov (free at api.data.gov) | none |
| `COURTLISTENER_API_TOKEN` | CourtListener | none |

Set `ALLINT_CONTACT_EMAIL`. SEC EDGAR and several other government hosts
throttle or refuse traffic that does not identify itself, and doing so is a
condition of their access policies.

---

## Status and what's next

Built: the core engine, the CLI, the trade import path and the forecasting
loop. Verified: 162 tests over parsing, entity resolution, detectors, scoring,
import, market matching and calibration. Unverified: the feed URLs, which need
`sources:check --fix` on a networked machine.

Shipped since:

1. **`sources:check --fix`** - 52 of 83 feeds confirmed live against their hosts.
2. **Triage and `investigate`** - the judgement stage, and the second look that
   only runs when a person asks for it. Not on the original list; it replaced
   the assumption that everything should be extracted.
3. **The web app** - Next.js over the same SQLite store, in `web/`. The reading
   queue, item dossiers, party pages, full-text search, and the investigate
   button wired to the same engine the CLI runs.
4. **PTR PDF parsing** - `ptr:fetch` reads the Clerk's filing PDFs directly, so
   congressional trade detail no longer needs an outside dataset. Roughly one
   filing in eight is a scan with no text layer; those are counted and
   reported, never silently skipped.
5. **Forecasting against live threads** - run against a real corpus for the
   first time. The loop proposes, the validator drops what cannot be scored,
   and `forecast:anchor` declines to match rather than reaching.

Still open, in order:

1. **Duplicate collapse.** Several outlets covering one event are judged
   independently and appear as separate sheets. Storyline work.
2. **The award side of the detectors.** 111 trade events span 2025-26 but every
   extracted award is 1978-2018, so `trade-then-award` has never had two halves
   in the same window. Gating extraction on triage starves it: a routine
   contract award reads as mundane news and is exactly the join material the
   detectors need. Structured record feeds should bypass the news gate the way
   market snapshots already do.
3. **OCR for scanned filings**, or an outside dataset for that eighth.
4. **Resolving forecasts.** Six are open; none has come due.

---

## The web app

```bash
npm run build          # the engine, including the .d.ts the app imports
npm run web            # http://localhost:3005
```

`web/` is a Next.js app over the same SQLite file. It reads through its own
read-only handle - a page render must never spend money - and the one route
that writes, `POST /api/investigate/:id`, imports the engine from `dist/`
rather than reimplementing it, so the app cannot drift from the tested path.

It looks like a declassified working file because that is what it is: a typed
form, a manila ground, and stamps that carry the verdict. The classification
banner is a register, not a claim.

## Development

```bash
npm run typecheck
npm run test
npm run build
npx tsx src/cli/index.ts <command>   # run without building
```
