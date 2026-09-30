import type { Config } from '../core/config.js';
import { politeFetch } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { structuredRecordTriage } from '../core/types.js';
import type { Item, Source } from '../core/types.js';

/**
 * Senate Lobbying Disclosure Act filings.
 *
 * Who paid whom to lobby which part of the government, on what, for how much -
 * and which of the lobbyists used to work there. Every quarterly report names
 * the client, the firm, the issues down to bill numbers, the agencies
 * contacted, and each lobbyist's former government post if they held one in
 * the last twenty years. That last field is the revolving door, recorded by the
 * people walking through it.
 *
 * Two queries per poll: quarterly reports above a spending floor, where money
 * moved, and new registrations, where a relationship began. Both are read
 * newest first and stop at the window.
 *
 * THE API IGNORES WHAT IT DOES NOT RECOGNISE. A misspelt or retired filter is
 * dropped silently and the answer is the whole database, presented as if
 * filtered. So every filter sent is applied again here - date, filing type,
 * amount - and a page that is entirely outside the window ends the read. A
 * filter the API stops honouring costs a wasted page, never a flood.
 *
 * Anonymous access is limited to about fifteen requests a minute, so requests
 * are spaced four seconds apart and a poll reads a few pages at most. A free
 * key from lda.senate.gov (LDA_API_KEY) raises the limit and the spacing drops.
 */

export const LDA_BASE = 'https://lda.senate.gov/api/v1/filings/';

/** Quarterly reports below this are routine retainers, not a signal. */
export const LDA_MIN_AMOUNT = 20_000;

const PAGE_SIZE = 25;
const MAX_PAGES_PER_QUERY = 4;

/** Contacted on nearly every filing, so naming them says nothing. */
const UBIQUITOUS_TARGETS = /^(u\.?s\.? )?(house of representatives|senate)(, u\.?s\.?)?$/i;

export interface LobbyistRecord {
  name: string;
  /** Former government post, as the filer wrote it. The revolving door. */
  coveredPosition: string | null;
}

export interface LobbyingActivity {
  issueCode: string | null;
  issue: string | null;
  description: string | null;
  governmentEntities: string[];
  lobbyists: LobbyistRecord[];
}

export interface LobbyingFiling {
  uuid: string;
  /** Q1-Q4 for quarterly reports, RR for a new registration. */
  filingType: string;
  filingYear: number | null;
  period: string | null;
  periodLabel: string | null;
  /** What a client paid an outside firm. */
  income: number | null;
  /** What an organisation spent lobbying for itself. */
  expenses: number | null;
  postedAt: string;
  documentUrl: string | null;
  registrant: string;
  client: string;
  clientDescription: string | null;
  /** The registrant is the client: an organisation lobbying on its own behalf. */
  inHouse: boolean;
  activities: LobbyingActivity[];
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
};

const money = (v: unknown): number | null => {
  const s = text(v)?.replace(/[$,]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const ACCEPTED_TYPE = /^(Q[1-4]|RR)$/;

/**
 * The filing's agency names in the form the rest of the corpus uses.
 *
 * LDA writes "Defense - Dept of (DOD)" and "Army - Dept of the"; award records
 * and the press say "Department of Defense" and "Department of the Army". Left
 * as filed, the agency a company lobbied and the agency that paid it would be
 * two parties, and the map could not walk from one to the other.
 */
export function agencyName(filed: string): string {
  const m = filed.match(/^(.+?)\s*-\s*Dept\.? of( the)?\s*(?:\([A-Z]+\))?$/i);
  return m ? `Department of${m[2] ? ' the' : ''} ${m[1]!.trim()}` : filed;
}

export function parseLobbyingFiling(raw: Record<string, unknown>): LobbyingFiling | null {
  const uuid = text(raw.filing_uuid);
  const filingType = text(raw.filing_type)?.toUpperCase() ?? '';
  const postedAt = text(raw.dt_posted);
  const registrant = text(obj(raw.registrant).name);
  const clientNode = obj(raw.client);
  const client = text(clientNode.name);
  // Amendments restate a filing already read; terminations carry no activity.
  if (!uuid || !ACCEPTED_TYPE.test(filingType) || !postedAt || !registrant || !client) return null;
  if (Number.isNaN(new Date(postedAt).getTime())) return null;

  const activities: LobbyingActivity[] = arr(raw.lobbying_activities).map((a) => ({
    issueCode: text(a.general_issue_code),
    issue: text(a.general_issue_code_display),
    description: text(a.description),
    governmentEntities: arr(a.government_entities)
      .map((g) => text(g.name)).filter((n): n is string => !!n).map(agencyName),
    lobbyists: arr(a.lobbyists).flatMap((l) => {
      const p = obj(l.lobbyist);
      const name = [p.first_name, p.middle_name, p.last_name, p.suffix]
        .map(text).filter(Boolean).join(' ');
      if (!name) return [];
      const covered = text(l.covered_position);
      // Filers write "N/A" and "None" into the field as often as they leave it blank.
      return [{ name, coveredPosition: covered && !/^(n\/?a|none|no|-+)$/i.test(covered) ? covered : null }];
    }),
  }));

  return {
    uuid,
    filingType,
    filingYear: Number(raw.filing_year) || null,
    period: text(raw.filing_period),
    periodLabel: text(raw.filing_period_display),
    income: money(raw.income),
    expenses: money(raw.expenses),
    postedAt: new Date(postedAt).toISOString(),
    documentUrl: text(raw.filing_document_url),
    registrant,
    client,
    clientDescription: text(clientNode.general_description),
    inHouse: registrant.toLowerCase() === client.toLowerCase(),
    activities,
  };
}

/** What the filing reports as spent, whichever side of the ledger it is on. */
export const lobbyingAmount = (f: LobbyingFiling): number | null => f.income ?? f.expenses;

const QUARTER_START: Record<string, string> = {
  first_quarter: '01-01', second_quarter: '04-01', third_quarter: '07-01', fourth_quarter: '10-01',
  Q1: '01-01', Q2: '04-01', Q3: '07-01', Q4: '10-01',
};

/**
 * When the lobbying began, as far as the filing says: the first day of the
 * quarter it reports on. A contract won mid-quarter was won while the lobbying
 * was under way, and dating the event by the day the report was posted - weeks
 * after the quarter closed - would put it after the award and hide the order.
 * A registration is dated by when it was posted.
 */
export function lobbyingDate(f: LobbyingFiling): string {
  const start = (f.period && QUARTER_START[f.period]) ?? QUARTER_START[f.filingType];
  if (f.filingType !== 'RR' && start && f.filingYear) {
    return new Date(`${f.filingYear}-${start}T12:00:00Z`).toISOString();
  }
  return f.postedAt;
}

export const quarterLabel = (f: LobbyingFiling): string | null =>
  /^Q[1-4]$/.test(f.filingType) && f.filingYear ? `${f.filingType} ${f.filingYear}` : null;

/** Agencies named, without the two chambers every filing names. */
export function targetsOf(f: LobbyingFiling): { agencies: string[]; congress: boolean } {
  const all = [...new Set(f.activities.flatMap((a) => a.governmentEntities))];
  return {
    agencies: all.filter((n) => !UBIQUITOUS_TARGETS.test(n)),
    congress: all.some((n) => UBIQUITOUS_TARGETS.test(n)),
  };
}

export function revolvingDoor(f: LobbyingFiling): LobbyistRecord[] {
  const seen = new Set<string>();
  return f.activities.flatMap((a) => a.lobbyists).filter((l) => {
    if (!l.coveredPosition || seen.has(l.name)) return false;
    seen.add(l.name);
    return true;
  });
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function lobbyingTitle(f: LobbyingFiling): string {
  if (f.filingType === 'RR') {
    return f.inHouse
      ? `${f.client} registered to lobby on its own behalf`
      : `${f.registrant} registered to lobby for ${f.client}`;
  }
  const amount = lobbyingAmount(f);
  const q = quarterLabel(f);
  return f.inHouse
    ? `${f.client} spent ${amount ? usd(amount) : 'an unreported sum'} lobbying${q ? `, ${q}` : ''}`
    : `${f.client} paid ${f.registrant} ${amount ? usd(amount) : 'an unreported sum'} to lobby${q ? `, ${q}` : ''}`;
}

export function lobbyingItem(f: LobbyingFiling, source: Source, fetchedAt = new Date().toISOString()): Item {
  const { agencies, congress } = targetsOf(f);
  const door = revolvingDoor(f);
  const body = [
    `Client: ${f.client}${f.clientDescription ? ` (${f.clientDescription})` : ''}`,
    f.inHouse ? 'Lobbying in-house.' : `Lobbying firm: ${f.registrant}`,
    f.periodLabel ? `Period: ${f.periodLabel}` : '',
    lobbyingAmount(f) !== null ? `Reported: ${usd(lobbyingAmount(f)!)}` : '',
    congress || agencies.length ? `Contacted: ${[congress ? 'Congress' : '', ...agencies].filter(Boolean).join('; ')}` : '',
    ...f.activities.map((a) => `Issue: ${[a.issue, a.description].filter(Boolean).join(' - ')}`),
    ...door.map((l) => `Lobbyist ${l.name}, formerly ${l.coveredPosition}`),
  ].filter(Boolean).join('\n');

  return {
    id: stableId('item', source.id, f.uuid),
    sourceId: source.id,
    externalId: f.uuid,
    url: f.documentUrl ?? `https://lda.senate.gov/filings/public/filing/${f.uuid}/print/`,
    title: lobbyingTitle(f),
    summary: null,
    body,
    author: f.registrant,
    publishedAt: f.postedAt,
    fetchedAt,
    raw: f as unknown as Record<string, unknown>,
    extractedAt: fetchedAt,
    ...structuredRecordTriage(fetchedAt),
    extractionError: null,
  };
}

/**
 * One page of the list, kept only where every filter asked for actually holds.
 * Returns the filings and whether the page reached back past the window, which
 * is where reading stops.
 */
export function keepFromPage(
  results: Record<string, unknown>[],
  sinceIso: string,
  want: 'report' | 'registration',
  minAmount = LDA_MIN_AMOUNT,
): { filings: LobbyingFiling[]; pastWindow: boolean } {
  const filings: LobbyingFiling[] = [];
  let pastWindow = false;
  for (const r of results) {
    const f = parseLobbyingFiling(r);
    const posted = text(r.dt_posted);
    if (posted && posted < sinceIso.slice(0, 10)) pastWindow = true;
    if (!f || f.postedAt < sinceIso) continue;
    if (want === 'registration' ? f.filingType !== 'RR' : f.filingType === 'RR') continue;
    if (want === 'report' && (lobbyingAmount(f) ?? 0) < minAmount) continue;
    filings.push(f);
  }
  return { filings, pastWindow };
}

export function buildLobbyingQuery(sinceDate: string, want: 'report' | 'registration'): string {
  const u = new URL(LDA_BASE);
  u.searchParams.set('filing_dt_posted_after', sinceDate);
  u.searchParams.set('ordering', '-dt_posted');
  u.searchParams.set('page_size', String(PAGE_SIZE));
  if (want === 'registration') u.searchParams.set('filing_type', 'RR');
  else u.searchParams.set('filing_amount_reported_min', String(LDA_MIN_AMOUNT));
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchLobbying(
  source: Source,
  cfg: Config,
  opts: { sinceDays?: number; maxPages?: number; spacingMs?: number } = {},
): Promise<Item[]> {
  const sinceDays = opts.sinceDays ?? 4;
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_QUERY;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.ldaApiKey) headers.Authorization = `Token ${cfg.ldaApiKey}`;
  const spacing = opts.spacingMs ?? (cfg.ldaApiKey ? 600 : 4_200);
  const fetchedAt = new Date().toISOString();

  const byUuid = new Map<string, LobbyingFiling>();
  let requests = 0;
  for (const want of ['report', 'registration'] as const) {
    let url: string | null = buildLobbyingQuery(since.slice(0, 10), want);
    for (let page = 0; url && page < maxPages; page++) {
      if (requests++ > 0) await sleep(spacing);
      const res = await politeFetch(url, cfg, { headers });
      const body = await res.json() as { results?: Record<string, unknown>[]; next?: string | null };
      const { filings, pastWindow } = keepFromPage(body.results ?? [], since, want);
      for (const f of filings) byUuid.set(f.uuid, f);
      url = pastWindow ? null : body.next ?? null;
    }
  }
  return [...byUuid.values()].map((f) => lobbyingItem(f, source, fetchedAt));
}
