#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import {
  connectionsSince, counts, eventsForEntity, findEntityByName, getEvent, getItem, insertConnection,
  getSource, listSources, listThreads, searchItems, setConnectionVerdict, threadEvents,
  topEntities, latestBrief, getThread,
} from '../core/store.js';
import { buildBrief } from '../pipeline/brief.js';
import { extract } from '../pipeline/extract.js';
import { checkSources, ingest, seedSources } from '../pipeline/ingest.js';
import { link } from '../pipeline/link.js';
import { runAllPairRules } from '../pipeline/detectors/deterministic.js';
import { updateThreads } from '../pipeline/threads.js';
import { seedDemo } from './demo.js';

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
  .command('extract')
  .description('Turn unprocessed items into structured events (uses the API)')
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
  .description('Full pipeline: ingest, extract, link, thread, brief')
  .option('--no-hypotheses', 'skip model-proposed connections')
  .action(async (o) => {
    const d = db();
    console.log('== ingest ==');
    const ing = await ingest(d, cfg, {});
    console.log(`${ing.reduce((n, r) => n + r.inserted, 0)} new items`);

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
