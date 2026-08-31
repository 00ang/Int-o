#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import {
  connectionsSince, counts, eventsForEntity, findEntityByName, getEvent, getItem, insertConnection,
  getSource, listSources, listThreads, searchItems, setConnectionVerdict, threadEvents,
  topEntities, latestBrief, getThread, tradeEvents, listForecasts, getForecast,
  resolveForecast, calibration, triagedQueue, getEntity,
} from '../core/store.js';
import { buildBrief } from '../pipeline/brief.js';
import { extract } from '../pipeline/extract.js';
import { checkSources, ingest, seedSources } from '../pipeline/ingest.js';
import { link } from '../pipeline/link.js';
import { runAllPairRules } from '../pipeline/detectors/deterministic.js';
import { updateThreads } from '../pipeline/threads.js';
import { seedDemo } from './demo.js';
import { triage } from '../pipeline/triage.js';
import { investigate } from '../pipeline/investigate.js';
import {
  importTradeFile, parseTradeFile, STOCK_ACT_FILING_DEADLINE_DAYS, type Chamber,
} from '../pipeline/import-trades.js';
import { readFileSync } from 'node:fs';
import {
  anchorForecasts, calibrationCurve, generateForecasts, marketComparison,
} from '../pipeline/forecast.js';

const cfg = loadConfig();
const db = () => openDb(cfg.dbPath);

const program = new Command();
program
  .name('throughline')
  .description('Personal intelligence system: ingest, connect, and follow world events.')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// Setup and sources
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Create the database and load the source registry')
  .action(() => {
    const d = db();
    const n = seedSources(d);
    console.log(`Database ready at ${cfg.dbPath}`);
    console.log(`Loaded ${n} sources.`);
    console.log('\nNext: throughline sources:check --fix');
    console.log('The registry ships unverified - that step confirms which feeds actually answer.');
  });

program
  .command('demo')
  .description('Load a synthetic corpus and run the detectors - no API key, no network')
  .action(() => {
    const d = db();
    const seeded = seedDemo(d);
    const found = runAllPairRules(d, new Date(Date.now() - 365 * 86_400_000).toISOString());
    for (const c of found) insertConnection(d, c);

    console.log(`Seeded ${seeded.items} synthetic items and ${seeded.events} events.`);
    console.log('(All names are invented. This shows the machinery, not a real claim.)\n');

    if (found.length === 0) {
      console.log('No connections found - that is a bug, please report it.');
      return;
    }
    for (const c of found) {
      const from = getEvent(d, c.fromEventId);
      const to = getEvent(d, c.toEventId);
      console.log(`[${c.kind}] confidence ${c.confidence.toFixed(2)}, lag ${Math.round(c.lagDays)}d`);
      console.log(`  ${c.explanation}`);
      if (from) console.log(`  A: ${from.summary}`);
      if (to) console.log(`  B: ${to.summary}`);
      if (c.falsifier) console.log(`  would falsify: ${c.falsifier}`);
      console.log();
    }
    console.log(`${found.length} connections found by deterministic rules alone.`);
  });

program
  .command('sources')
  .description('List configured sources')
  .option('-t, --tier <tier>', 'filter by tier')
  .option('--unverified', 'only sources not yet confirmed reachable')
  .action((o) => {
    let rows = listSources(db());
    if (o.tier) rows = rows.filter((s) => s.tier === o.tier);
    if (o.unverified) rows = rows.filter((s) => !s.verified);
    for (const s of rows) {
      const flags = [s.enabled ? '' : 'disabled', s.verified ? 'verified' : 'unverified']
        .filter(Boolean).join(',');
      console.log(`${s.tier.padEnd(9)} ${s.id.padEnd(24)} ${flags.padEnd(20)} ${s.name}`);
    }
    console.log(`\n${rows.length} sources.`);
  });

program
  .command('sources:check')
  .description('Probe every source and report which ones answer')
  .option('--fix', 'mark working sources verified and disable the rest')
  .action(async (o) => {
    const d = db();
    let ok = 0;
    const results = await checkSources(d, cfg, {
      fix: o.fix,
      onProgress: (c) => {
        if (c.ok) ok++;
        console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.sourceId.padEnd(24)} ${c.detail}`);
      },
    });
    console.log(`\n${ok}/${results.length} sources reachable.`);
    if (!o.fix) console.log('Re-run with --fix to persist these results.');
  });

// ---------------------------------------------------------------------------
// Trade import
// ---------------------------------------------------------------------------

program
  .command('import:trades <file>')
  .description('Import disclosed trades from a CSV or JSON file')
  .option('--source-id <id>', 'source id to file these under', 'imported-trades')
  .option('--source-name <name>', 'human-readable source name')
  .option('--chamber <chamber>', 'house, senate or other; inferred from the columns if omitted')
  .option('--tier <tier>', 'credibility tier for the source row', 'primary')
  .option('-l, --limit <n>', 'import at most this many rows', Number)
  .option('-n, --dry-run', 'parse and report, write nothing')
  .action((file: string, o) => {
    if (o.chamber && !['house', 'senate', 'other'].includes(o.chamber)) {
      console.error('--chamber must be house, senate or other.');
      process.exitCode = 1;
      return;
    }
    const text = readFileSync(file, 'utf8');

    if (o.dryRun) {
      const { trades, skipped, columns } = parseTradeFile(text, { chamber: o.chamber as Chamber });
      console.log(`Would import ${trades.length} trades from ${file}.`);
      reportColumns(columns);
      reportSkipped(skipped);
      for (const t of trades.slice(0, 5)) console.log(`  ${t.transactedAt.slice(0, 10)}  ${t.filer} ${t.action} ${t.ticker ?? t.assetName ?? '?'}`);
      if (trades.length > 5) console.log(`  ... and ${trades.length - 5} more`);
      return;
    }

    const r = importTradeFile(db(), text, {
      file,
      sourceId: o.sourceId,
      sourceName: o.sourceName,
      tier: o.tier,
      chamber: o.chamber as Chamber,
      limit: o.limit,
    });

    console.log(`Parsed ${r.parsed} trades from ${file}.`);
    reportColumns(r.columns);
    reportSkipped(r.skipped);
    console.log(`\n${r.itemsInserted} new items, ${r.eventsWritten} events written under source "${r.sourceId}".`);
    if (r.withoutTicker > 0) {
      console.log(`${r.withoutTicker} had no identifiable issuer - recorded, but they cannot join to an award.`);
    }
    if (r.lateFilings > 0) {
      console.log(`${r.lateFilings} were filed past the ${STOCK_ACT_FILING_DEADLINE_DAYS}-day STOCK Act deadline. See: throughline trades --late`);
    }
    console.log('\nNext: throughline link   (trade-then-award now has congressional trades to join)');
  });

function reportColumns(columns: Record<string, string | undefined>): void {
  const found = Object.entries(columns).filter(([, v]) => v !== undefined);
  console.log(`Columns matched: ${found.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  // Say plainly what is missing, because each absence disables something
  // downstream rather than merely degrading it.
  if (!columns.ticker) console.log('  No ticker column: issuer matching will rely on asset descriptions.');
  if (!columns.disclosureDate) console.log('  No disclosure date column: filing lag cannot be computed.');
}

function reportSkipped(skipped: { reason: string }[]): void {
  if (skipped.length === 0) return;
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  console.log(`Skipped ${skipped.length} rows:`);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }
}

program
  .command('trades')
  .description('Browse disclosed trades, newest first')
  .option('--late', `only trades filed past the ${STOCK_ACT_FILING_DEADLINE_DAYS}-day deadline`)
  .option('-c, --congressional', 'only congressional trades')
  .option('-f, --filer <name>', 'only this filer')
  .option('-l, --limit <n>', 'how many', Number, 40)
  .action((o) => {
    const rows = tradeEvents(db(), {
      lateOnly: o.late,
      congressionalOnly: o.congressional,
      filer: o.filer,
      limit: o.limit,
    });
    if (rows.length === 0) {
      console.log('No trades match. Import some: throughline import:trades <file>');
      return;
    }
    for (const ev of rows) {
      const lag = ev.tags.find((t) => t.startsWith('disclosure-lag:'))?.split(':')[1];
      // A negative lag is a data error worth seeing, so sign it rather than
      // prefixing everything with '+'.
      const lagCell = lag === undefined ? '' : `${Number(lag) >= 0 ? '+' : ''}${lag}d`;
      const flag = ev.tags.includes('late-filing') ? ' LATE' : '';
      console.log(`${ev.occurredAt.slice(0, 10)}  ${lagCell.padStart(6)}${flag.padEnd(5)} ${ev.summary}`);
    }
    const late = rows.filter((e) => e.tags.includes('late-filing')).length;
    console.log(`\n${rows.length} shown, ${late} filed late.`);
  });

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

program
  .command('ingest')
  .description('Fetch new items from due sources')
  .option('-a, --all', 'ignore polling intervals and fetch every enabled source')
  .option('-s, --source <ids...>', 'fetch only these sources')
  .action(async (o) => {
    const d = db();
    let inserted = 0;
    await ingest(d, cfg, {
      all: o.all,
      sourceIds: o.source,
      onProgress: (r) => {
        inserted += r.inserted;
        const status = r.error ? `ERROR ${r.error}` : `${r.inserted} new / ${r.fetched} fetched`;
        console.log(`${r.sourceId.padEnd(24)} ${status}`);
      },
    });
    console.log(`\n${inserted} new items.`);
  });

program
  .command('triage')
  .description('Read new items and decide what deserves attention (uses the API, cheaply)')
  .option('-l, --limit <n>', 'maximum items to judge', Number)
  .action(async (o) => {
    const d = db();
    const counts = { notable: 0, 'worth-a-look': 0, mundane: 0 };
    const run = await triage(d, cfg, {
      limit: o.limit,
      onBatch: (rs) => {
        for (const r of rs) {
          counts[r.verdict] += 1;
          if (r.verdict === 'mundane') continue;
          console.log(`${r.verdict === 'notable' ? '**' : ' *'} ${r.topic}`);
          if (r.angle) console.log(`     ${r.angle}`);
        }
      },
    });
    const judged = run.results.length;
    console.log(
      `\n${judged} items judged in ${run.batches} calls: ` +
      `${counts.notable} notable, ${counts['worth-a-look']} worth a look, ${counts.mundane} mundane.`,
    );
    // A run where most things are interesting means the filter is not filtering.
    if (judged > 0) {
      const kept = judged - counts.mundane;
      console.log(`${Math.round((kept / judged) * 100)}% kept.`);
    }
    if (run.unjudged > 0) {
      console.log(`${run.unjudged} items returned no judgement and stay queued.`);
    }
    console.log('\nNext: throughline queue');
  });

program
  .command('queue')
  .description('What survived triage - the reading list')
  .option('-n, --limit <n>', 'how many to show', Number, 30)
  .option('--notable', 'only the notable ones')
  .option('--angles', 'only items with something to pull on')
  .action((o) => {
    const rows = triagedQueue(db(), {
      limit: o.limit,
      verdict: o.notable ? 'notable' : undefined,
      withAngle: o.angles,
    });
    if (rows.length === 0) {
      console.log('Nothing in the queue. Run: throughline triage');
      return;
    }
    for (const it of rows) {
      const mark = it.triageVerdict === 'notable' ? '**' : ' *';
      console.log(`${mark} ${it.publishedAt.slice(0, 10)}  ${it.triageTopic}`);
      console.log(`     ${it.title}`);
      if (it.triageAngle) console.log(`     angle: ${it.triageAngle}`);
      console.log(`     ${it.id}`);
      console.log();
    }
    console.log(`${rows.length} items. Investigate one: throughline investigate <id>`);
  });

program
  .command('investigate <id>')
  .description('Take a second look at one item: its parties, what else touches them, what joins')
  .option('-d, --window-days <n>', 'how far either side to look', Number, 180)
  .option('-H, --hypotheses', 'also ask the model to propose links (uses the API)')
  .action(async (id, o) => {
    const d = db();
    const inv = await investigate(d, cfg, id, {
      windowDays: o.windowDays,
      hypotheses: o.hypotheses,
    });

    console.log(inv.item.title);
    console.log(inv.item.url);
    if (inv.item.triageAngle) console.log(`\nangle: ${inv.item.triageAngle}`);
    if (inv.extractedNow) console.log('(extracted for this investigation)');

    console.log(`\nEVENTS IN THIS ITEM (${inv.events.length})`);
    for (const e of inv.events) {
      console.log(`  ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary}`);
      const parties = e.entities
        .filter((en) => en.role !== 'mentioned')
        .map((en) => `${getEntity(d, en.entityId)?.name ?? '?'} (${en.role})`);
      if (parties.length) console.log(`    ${parties.join(', ')}`);
    }

    console.log(`\nELSEWHERE IN THE CORPUS, SAME PARTIES (${inv.related.length})`);
    for (const e of inv.related.slice(0, 15)) {
      console.log(`  ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary}`);
    }
    if (inv.related.length === 0) console.log('  nothing');

    console.log(`\nOTHER INGESTED ITEMS MENTIONING THESE PARTIES (${inv.relatedItems.length})`);
    for (const it of inv.relatedItems.slice(0, 12)) {
      console.log(`  ${it.publishedAt.slice(0, 10)} ${it.title}`);
    }
    if (inv.relatedItems.length === 0) console.log('  nothing');

    const all = [...inv.connections, ...inv.hypotheses];
    console.log(`\nCONNECTIONS (${all.length})`);
    for (const c of all) {
      const from = getEvent(d, c.fromEventId);
      const to = getEvent(d, c.toEventId);
      console.log(`  [${c.basis}/${c.kind}] confidence ${c.confidence.toFixed(2)}, lag ${Math.round(c.lagDays)}d`);
      console.log(`    ${c.explanation}`);
      if (from) console.log(`    A: ${from.summary}`);
      if (to) console.log(`    B: ${to.summary}`);
      if (c.falsifier) console.log(`    would falsify: ${c.falsifier}`);
    }
    if (all.length === 0) {
      // The honest and most common outcome. Said plainly so it does not read as
      // a failure to run.
      console.log('  Nothing joined. That is the common result and it is a real answer:');
      console.log('  no other event in the corpus shares a party with this one inside the window.');
      if (!o.hypotheses) console.log('  Try -H to have the model propose links, capped and falsifiable.');
    }
  });

program
  .command('extract')
  .description('Turn triaged items into structured events (uses the API)')
  .option('-l, --limit <n>', 'maximum items to process', Number)
  .action(async (o) => {
    const d = db();
    let events = 0;
    let failures = 0;
    const results = await extract(d, cfg, {
      limit: o.limit,
      onProgress: (r) => {
        if (r.error) { failures++; console.log(`ERROR ${r.itemId}: ${r.error}`); }
        else events += r.eventCount;
      },
    });
    console.log(`${results.length} items processed, ${events} events, ${failures} failures.`);
  });

program
  .command('link')
  .description('Find connections between events')
  .option('-d, --since-days <n>', 'window to consider', Number, 7)
  .option('-H, --hypotheses', 'also generate model-proposed links (uses the API)')
  .action(async (o) => {
    const r = await link(db(), cfg, { sinceDays: o.sinceDays, hypotheses: o.hypotheses });
    console.log(`deterministic: ${r.deterministic}`);
    console.log(`entity overlap: ${r.entityOverlap}`);
    console.log(`hypotheses: ${r.hypotheses}`);
  });

program
  .command('threads:update')
  .description('Assign new events to storylines and refresh summaries (uses the API)')
  .option('-d, --since-days <n>', 'window to consider', Number, 3)
  .action(async (o) => {
    const r = await updateThreads(db(), cfg, { sinceDays: o.sinceDays });
    console.log(
      `assigned ${r.assigned}, created ${r.created}, resynthesized ${r.synthesized}, retired ${r.retired}`,
    );
  });

program
  .command('run')
  .description('Full pipeline: ingest, triage, extract, link, thread, brief')
  .option('--no-hypotheses', 'skip model-proposed connections')
  .action(async (o) => {
    const d = db();
    console.log('== ingest ==');
    const ing = await ingest(d, cfg, {});
    console.log(`${ing.reduce((n, r) => n + r.inserted, 0)} new items`);

    // Triage gates everything downstream: extraction only ever runs on what
    // this stage decided was worth reading.
    console.log('== triage ==');
    const tr = await triage(d, cfg, {});
    const kept = tr.results.filter((r) => r.verdict !== 'mundane').length;
    console.log(`${tr.results.length} judged, ${kept} kept`);

    console.log('== extract ==');
    const ex = await extract(d, cfg, {});
    console.log(`${ex.reduce((n, r) => n + r.eventCount, 0)} events`);

    console.log('== link ==');
    const li = await link(d, cfg, { hypotheses: o.hypotheses });
    console.log(`${li.deterministic} deterministic, ${li.hypotheses} hypotheses`);

    console.log('== threads ==');
    const th = await updateThreads(d, cfg, {});
    console.log(`${th.assigned} assigned, ${th.created} new`);

    console.log('== brief ==');
    const brief = await buildBrief(d, cfg, {});
    console.log(`\n${brief.markdown}`);
  });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

program
  .command('brief')
  .description('Generate the brief for the current window (uses the API)')
  .option('-w, --window-hours <n>', 'lookback window', Number, 24)
  .action(async (o) => {
    const brief = await buildBrief(db(), cfg, { windowHours: o.windowHours });
    console.log(brief.markdown);
  });

program
  .command('brief:last')
  .description('Print the most recent stored brief without regenerating it')
  .action(() => {
    const b = latestBrief(db());
    console.log(b ? b.markdown : 'No brief stored yet.');
  });

program
  .command('threads')
  .description('List storylines')
  .option('-s, --status <status>', 'active, dormant or closed', 'active')
  .action((o) => {
    const rows = listThreads(db(), o.status);
    for (const t of rows) {
      console.log(`${t.id}  ${t.lastEventAt.slice(0, 10)}  ${String(t.eventCount).padStart(3)} events  ${t.title}`);
    }
    console.log(`\n${rows.length} ${o.status} storylines.`);
  });

program
  .command('thread <id>')
  .description('Show one storyline with its full timeline')
  .action((id: string) => {
    const d = db();
    const t = getThread(d, id);
    if (!t) { console.error(`No thread ${id}`); process.exitCode = 1; return; }
    console.log(`# ${t.title}\n`);
    console.log(t.summary || '(no synthesis yet)');
    if (t.openQuestions.length) {
      console.log('\nWatching for:');
      for (const q of t.openQuestions) console.log(`  - ${q}`);
    }
    console.log('\n## Timeline\n');
    for (const e of threadEvents(d, id)) {
      const item = getItem(d, e.itemId);
      console.log(`${e.occurredAt.slice(0, 10)}  ${e.summary}`);
      if (item) console.log(`            ${item.url}`);
    }
  });

program
  .command('connections')
  .description('List recent connections, strongest evidence first')
  .option('-d, --since-days <n>', 'window', Number, 7)
  .option('-b, --basis <basis>', 'deterministic, entity-overlap or hypothesis')
  .option('-m, --min-confidence <n>', 'minimum confidence', Number, 0.2)
  .action((o) => {
    const d = db();
    const since = new Date(Date.now() - o.sinceDays * 86_400_000).toISOString();
    let rows = connectionsSince(d, since, o.minConfidence);
    if (o.basis) rows = rows.filter((c) => c.basis === o.basis);
    for (const c of rows) {
      const from = getEvent(d, c.fromEventId);
      const to = getEvent(d, c.toEventId);
      console.log(`\n[${c.basis}] ${c.kind}  confidence=${c.confidence.toFixed(2)} lag=${Math.round(c.lagDays)}d`);
      console.log(`  id: ${c.id}`);
      console.log(`  ${c.explanation}`);
      if (from) console.log(`  A: ${from.summary}`);
      if (to) console.log(`  B: ${to.summary}`);
      if (c.falsifier) console.log(`  falsify by: ${c.falsifier}`);
    }
    console.log(`\n${rows.length} connections.`);
  });

program
  .command('verdict <connectionId> <verdict>')
  .description('Record your judgement on a connection: sound, coincidence or wrong')
  .action((id: string, verdict: string) => {
    if (!['sound', 'coincidence', 'wrong', 'unreviewed'].includes(verdict)) {
      console.error('Verdict must be sound, coincidence, wrong or unreviewed.');
      process.exitCode = 1;
      return;
    }
    setConnectionVerdict(db(), id, verdict as never);
    console.log(`${id} marked ${verdict}.`);
  });

program
  .command('entity <name>')
  .description('Show what an entity has been involved in')
  .action((name: string) => {
    const d = db();
    const e = findEntityByName(d, name);
    if (!e) { console.error(`No entity matching "${name}".`); process.exitCode = 1; return; }
    console.log(`${e.name} (${e.kind})${e.ticker ? ` [${e.ticker}]` : ''}`);
    console.log(`${e.mentionCount} mentions, first seen ${e.firstSeenAt.slice(0, 10)}\n`);
    for (const ev of eventsForEntity(d, e.id, 50)) {
      console.log(`${ev.occurredAt.slice(0, 10)}  ${ev.type.padEnd(20)} ${ev.summary}`);
    }
  });

program
  .command('entities')
  .description('Most-mentioned entities')
  .option('-l, --limit <n>', 'how many', Number, 30)
  .action((o) => {
    for (const e of topEntities(db(), o.limit)) {
      console.log(`${String(e.mentionCount).padStart(5)}  ${e.kind.padEnd(18)} ${e.name}`);
    }
  });

program
  .command('search <query>')
  .description('Full-text search over ingested material')
  .option('-l, --limit <n>', 'how many', Number, 25)
  .action((query: string, o) => {
    const d = db();
    for (const item of searchItems(d, query, o.limit)) {
      const s = getSource(d, item.sourceId);
      console.log(`${item.publishedAt.slice(0, 10)}  [${s?.tier ?? '?'}] ${item.title}`);
      console.log(`            ${item.url}`);
    }
  });

// ---------------------------------------------------------------------------
// Forecasting
// ---------------------------------------------------------------------------

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

program
  .command('forecast')
  .description('Propose scoreable forecasts from active storylines (uses the API)')
  .option('-t, --thread <id>', 'only this storyline')
  .option('--min-events <n>', 'skip storylines thinner than this', Number, 3)
  .option('--max-threads <n>', 'cap storylines per run', Number, 8)
  .action(async (o) => {
    const r = await generateForecasts(db(), cfg, {
      threadId: o.thread,
      minEvents: o.minEvents,
      maxThreads: o.maxThreads,
      onProgress: (title, stored) => console.log(`${String(stored).padStart(2)} from  ${title}`),
    });
    console.log(`\n${r.threadsConsidered} storylines considered, ${r.proposed} proposed, ${r.stored} stored.`);
    // Say what was thrown away and why. A silent drop rate is how a forecasting
    // loop quietly stops forecasting.
    for (const x of r.rejected) console.log(`  rejected: ${x.reason}\n            ${x.question}`);
    if (r.stored > 0) console.log('\nNext: throughline forecast:anchor   (put a market price beside each one)');
  });

program
  .command('forecast:anchor')
  .description('Match open forecasts to prediction markets already ingested')
  .option('--min-score <n>', 'similarity floor for a match', Number)
  .option('--reanchor', 're-match forecasts that already carry a price')
  .action((o) => {
    const r = anchorForecasts(db(), { minScore: o.minScore, reanchor: o.reanchor });
    if (r.marketsAvailable === 0) {
      console.log('No prediction-market snapshots in the corpus. Ingest polymarket/kalshi/metaculus first.');
      return;
    }
    console.log(`${r.marketsAvailable} markets available. ${r.anchored} anchored, ${r.unmatched} left unmatched.`);
    if (r.disagreements.length > 0) {
      console.log('\nWhere we differ most from the crowd:');
      for (const d of r.disagreements.slice(0, 10)) {
        console.log(`  us ${pct(d.forecast.probability)} vs market ${pct(d.market.probability!)}  (${pct(d.gap)} apart)`);
        console.log(`     ${d.forecast.question}`);
        console.log(`     ${d.market.url}`);
      }
    }
  });

program
  .command('forecasts')
  .description('List forecasts')
  .option('--open', 'only unresolved')
  .option('--due', 'only unresolved and past their resolution date')
  .option('--resolved', 'only resolved')
  .option('-l, --limit <n>', 'how many', Number, 50)
  .action((o) => {
    const status = o.due ? 'due' : o.resolved ? 'resolved' : o.open ? 'open' : 'all';
    const rows = listForecasts(db(), { status, limit: o.limit });
    if (rows.length === 0) { console.log('No forecasts. Make some: throughline forecast'); return; }
    for (const f of rows) {
      const mkt = f.marketProbability === null ? '' : `  mkt ${pct(f.marketProbability)}`;
      const outcome = f.outcome ? `  → ${f.outcome}${f.brierScore === null ? '' : ` (brier ${f.brierScore.toFixed(3)})`}` : '';
      console.log(`${f.id}  ${f.resolvesAt.slice(0, 10)}  ${pct(f.probability).padStart(4)}${mkt}${outcome}`);
      console.log(`  ${f.question}`);
    }
    const due = listForecasts(db(), { status: 'due', limit: 500 }).length;
    if (due > 0 && status !== 'due') {
      console.log(`\n${due} past their resolution date and unscored: throughline forecasts --due`);
    }
  });

program
  .command('forecast:show <id>')
  .description('Read one forecast in full')
  .action((id: string) => {
    const d = db();
    const f = getForecast(d, id);
    if (!f) { console.error(`No forecast ${id}.`); process.exitCode = 1; return; }
    console.log(f.question);
    console.log(`\nOur estimate    ${pct(f.probability)}`);
    if (f.marketProbability !== null) console.log(`Market          ${pct(f.marketProbability)}  ${f.marketUrl ?? ''}`);
    console.log(`Resolves        ${f.resolvesAt.slice(0, 10)}`);
    console.log(`\nResolution criteria\n  ${f.resolutionCriteria}`);
    if (f.referenceClass) console.log(`\nReference class\n  ${f.referenceClass}`);
    console.log(`\nReasoning\n  ${f.reasoning}`);
    if (f.threadId) console.log(`\nStoryline       ${getThread(d, f.threadId)?.title ?? f.threadId}`);
    if (f.evidenceEventIds.length > 0) {
      console.log('\nEvidence');
      for (const id of f.evidenceEventIds) {
        const ev = getEvent(d, id);
        if (ev) console.log(`  ${ev.occurredAt.slice(0, 10)}  ${ev.summary}`);
      }
    }
    if (f.outcome) {
      console.log(`\nResolved ${f.resolvedAt?.slice(0, 10)} as ${f.outcome}` +
        (f.brierScore === null ? '' : `, Brier ${f.brierScore.toFixed(4)}`));
    }
  });

program
  .command('forecast:resolve <id> <outcome>')
  .description('Record what actually happened and score it')
  .action((id: string, outcome: string) => {
    if (!['yes', 'no', 'ambiguous'].includes(outcome)) {
      console.error('Outcome must be yes, no or ambiguous.');
      process.exitCode = 1;
      return;
    }
    const d = db();
    const f = getForecast(d, id);
    if (!f) { console.error(`No forecast ${id}.`); process.exitCode = 1; return; }
    const brier = resolveForecast(d, id, outcome as 'yes' | 'no' | 'ambiguous');
    console.log(`${f.question}`);
    console.log(`  said ${pct(f.probability)}, resolved ${outcome}` +
      (brier === null ? ' (not scored)' : `, Brier ${brier.toFixed(4)}`));
    if (brier !== null && f.marketProbability !== null) {
      const marketBrier = (f.marketProbability - (outcome === 'yes' ? 1 : 0)) ** 2;
      const verdict = brier < marketBrier ? 'we beat the market' : brier > marketBrier ? 'the market beat us' : 'tied with the market';
      console.log(`  market said ${pct(f.marketProbability)}, Brier ${marketBrier.toFixed(4)} - ${verdict}`);
    }
  });

program
  .command('calibration')
  .description('How well the forecasts have actually scored')
  .action(() => {
    const d = db();
    const { count, meanBrier } = calibration(d);
    if (count === 0) {
      console.log('Nothing resolved yet. Score some: throughline forecasts --due');
      return;
    }
    console.log(`${count} resolved, mean Brier ${meanBrier!.toFixed(4)}.`);
    console.log('(0.25 is what guessing 50% every time gets you. Lower is better.)\n');

    console.log('said        n   we said   happened');
    for (const b of calibrationCurve(listForecasts(d, { status: 'resolved', limit: 1000 }))) {
      const label = `${pct(b.from)}-${pct(b.to)}`.padEnd(10);
      if (b.count === 0) { console.log(`${label} ${String(0).padStart(3)}         -          -`); continue; }
      console.log(`${label} ${String(b.count).padStart(3)}     ${pct(b.meanPredicted).padStart(5)}      ${pct(b.observedYesRate).padStart(5)}`);
    }

    const m = marketComparison(listForecasts(d, { status: 'resolved', limit: 1000 }));
    if (m.count > 0) {
      console.log(`\nAgainst the market, on the ${m.count} anchored and resolved:`);
      console.log(`  us     ${m.ourBrier!.toFixed(4)}`);
      console.log(`  market ${m.marketBrier!.toFixed(4)}`);
      console.log(m.ourBrier! < m.marketBrier!
        ? '  We are ahead. Keep scoring; the sample is what makes this real.'
        : '  The market is ahead. That is the honest answer until it is not.');
    }
  });

program
  .command('stats')
  .description('Corpus size')
  .action(() => {
    for (const [k, v] of Object.entries(counts(db()))) {
      console.log(`${k.padEnd(14)} ${v}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
