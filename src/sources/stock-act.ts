import { inflateRawSync } from 'node:zlib';
import type { Config } from '../core/config.js';
import { politeFetch } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { UNTRIAGED } from '../core/types.js';
import type { Item, Source } from '../core/types.js';

/**
 * Congressional financial disclosures (STOCK Act).
 *
 * SCOPE - read this before relying on it.
 *
 * The House Clerk publishes a yearly ZIP whose index lists every disclosure
 * filed: member name, filing type, filing date, document id. That index is what
 * this adapter reads, and it is genuinely useful - it tells you which member
 * filed a periodic transaction report and when.
 *
 * What it does NOT give you is the ticker, direction or size of the trade.
 * Those live in the per-filing PDF, and a meaningful share of those PDFs are
 * scans without a text layer. So this adapter produces "member filed a PTR"
 * events, not "member bought Lockheed" events.
 *
 * The trade-then-award detector therefore runs on `securities-trade` events
 * from whichever source can supply a ticker:
 *   - SEC Form 4, which is structured and complete for corporate insiders; and
 *   - `all-int import:trades <csv>`, for congressional trade data you have
 *     parsed or obtained elsewhere.
 *
 * Do not read the absence of congressional trade detail as an absence of
 * congressional trading.
 */

export interface DisclosureRow {
  prefix: string;
  last: string;
  first: string;
  suffix: string;
  filingType: string;
  stateDst: string;
  year: string;
  filingDate: string;
  docId: string;
}

/** Filing type codes used in the House index. */
const FILING_TYPE_NAMES: Record<string, string> = {
  P: 'Periodic Transaction Report',
  O: 'Original Annual Report',
  A: 'Amendment',
  C: 'Candidate Report',
  T: 'Termination Report',
  W: 'Withdrawal',
  D: 'Due Date Extension',
  E: 'Extension',
  X: 'Termination',
};

/**
 * Minimal reader for a single entry out of a ZIP archive.
 *
 * The House index is one small text file in one archive; pulling in a ZIP
 * library for that is not worth the dependency. Handles stored (method 0) and
 * deflated (method 8) entries, which is everything this endpoint produces.
 */
export function readZipEntry(buf: Buffer, predicate: (name: string) => boolean): Buffer | null {
  const SIG = 0x04034b50;
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== SIG) {
      // Not at a local file header; scan forward to the next signature.
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), off + 1);
      if (next === -1) return null;
      off = next;
      continue;
    }
    const method = buf.readUInt16LE(off + 8);
    const compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;

    if (compressedSize === 0) return null; // streamed entry, size only in the trailer
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (predicate(name)) {
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    off = dataStart + compressedSize;
  }
  return null;
}

/** The index is tab-delimited with a header row. */
export function parseDisclosureIndex(text: string): DisclosureRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  return lines.slice(1).flatMap((line) => {
    const c = line.split('\t');
    if (c.length < 9) return [];
    return [{
      prefix: (c[0] ?? '').trim(),
      last: (c[1] ?? '').trim(),
      first: (c[2] ?? '').trim(),
      suffix: (c[3] ?? '').trim(),
      filingType: (c[4] ?? '').trim(),
      stateDst: (c[5] ?? '').trim(),
      year: (c[6] ?? '').trim(),
      filingDate: (c[7] ?? '').trim(),
      docId: (c[8] ?? '').trim(),
    }];
  });
}

/** US date strings in the index are M/D/YYYY. */
function toIso(mdY: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) {
    const d = new Date(mdY);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const [, mm, dd, yyyy] = m;
  return new Date(Date.UTC(+yyyy!, +mm! - 1, +dd!, 12)).toISOString();
}

export function disclosuresToItems(
  rows: DisclosureRow[],
  source: Source,
  year: number,
  fetchedAt = new Date().toISOString(),
): Item[] {
  return rows
    // Periodic transaction reports and their amendments are the ones that
    // signal a trade happened; annual reports are a yearly snapshot.
    .filter((r) => r.filingType === 'P' || r.filingType === 'A')
    .map((r) => {
      const name = [r.prefix, r.first, r.last, r.suffix].filter(Boolean).join(' ').trim();
      const typeName = FILING_TYPE_NAMES[r.filingType] ?? r.filingType;
      const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${r.docId}.pdf`;
      return {
        id: stableId('item', source.id, r.docId),
        sourceId: source.id,
        externalId: r.docId,
        url,
        title: `${name} filed a ${typeName}`,
        summary: `US Representative ${name} (${r.stateDst}) filed a ${typeName} on ${r.filingDate}.`,
        body: [
          `Filer: ${name}`,
          `Chamber: US House of Representatives`,
          `District: ${r.stateDst}`,
          `Filing type: ${typeName}`,
          `Filing date: ${r.filingDate}`,
          `Document: ${url}`,
          'Transaction detail (ticker, direction, amount) is in the linked PDF and is not in this index.',
        ].join('\n'),
        author: 'US House Clerk',
        publishedAt: toIso(r.filingDate),
        fetchedAt,
        raw: r as unknown as Record<string, unknown>,
        extractedAt: null,
        ...UNTRIAGED,
        extractionError: null,
      };
    });
}

export async function fetchStockAct(
  source: Source,
  cfg: Config,
  year = new Date().getUTCFullYear(),
): Promise<Item[]> {
  if (source.id !== 'house-disclosures') {
    // The Senate system requires accepting terms behind a session cookie before
    // it will answer a search; that is a scraping problem, not a fetch problem.
    throw new Error(
      `Source ${source.id} needs an interactive session; only house-disclosures is automated.`,
    );
  }
  const zipUrl = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
  const res = await politeFetch(zipUrl, cfg);
  const buf = Buffer.from(await res.arrayBuffer());
  const entry = readZipEntry(buf, (n) => n.toLowerCase().endsWith('.txt'));
  if (!entry) throw new Error(`No index text file found in ${zipUrl}`);
  return disclosuresToItems(parseDisclosureIndex(entry.toString('utf8')), source, year);
}
