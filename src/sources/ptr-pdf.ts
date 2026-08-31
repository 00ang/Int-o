import type { Config } from '../core/config.js';
import { politeFetch } from '../core/http.js';
import {
  type Chamber, type TradeRecord, mapColumns, normalizeRow,
} from '../pipeline/import-trades.js';

/**
 * Periodic Transaction Reports, read from the filing PDFs themselves.
 *
 * This closes the gap `stock-act.ts` documents. The House Clerk's index tells
 * you that a member filed a PTR and when; the ticker, direction and size are
 * only in the per-filing PDF. Until now that meant congressional trade detail
 * had to come from an outside dataset via `import:trades`. It no longer does.
 *
 * WHAT THIS CANNOT DO. A meaningful share of these filings are scans with no
 * text layer - a photograph of a paper form. There is no OCR here, and adding
 * one would be a different project with a different error profile. Those
 * filings are counted and reported as unreadable, never silently dropped,
 * because a quiet skip is how a coverage gap turns into a false negative.
 *
 * Everything parsed here is handed to the same `normalizeRow` the CSV importer
 * uses, so bands, dates, tickers, filing lag and the rows worth dropping are
 * decided in exactly one place.
 */

/** Where the Clerk serves a filing, by year and document id. */
export function ptrPdfUrl(year: string | number, docId: string): string {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

/**
 * One transaction line as it appears in the filing table.
 *
 * The table renders as: asset name, an optional ticker in parentheses, a
 * bracketed asset-type code, the transaction type, the transaction date, the
 * notification date, and the amount band. The type code is the reliable anchor
 * - it is always bracketed and always two letters - so the row is matched from
 * there outward rather than by counting whitespace, which the PDF does not
 * preserve.
 */
const ROW = new RegExp(
  [
    '([^\\[\\]\\n]{3,160}?)',                    // asset description
    '\\s*\\[([A-Z]{2})\\]\\s*',                  // [ST], [OP], [CS] ...
    '(S \\(partial\\)|[PSE])\\s+',               // transaction type
    '(\\d{2}/\\d{2}/\\d{4})\\s+',                // transaction date
    '(\\d{2}/\\d{2}/\\d{4})\\s+',                // notification date
    '(\\$[\\d,]+\\s*-\\s*\\$[\\d,]+|Over \\$[\\d,]+|\\$[\\d,]+\\s*\\+?)', // amount band
  ].join(''),
  'g',
);

const TICKER = /\(([A-Z][A-Z.\-]{0,5})\)\s*$/;

/**
 * Trim the asset description back to the asset.
 *
 * The rows are matched from the bracketed type code outward, so the capture
 * runs backwards into whatever sat between this row and the last one: the
 * column headers on the first row, and on every row after that the filer's own
 * annotations ("F S : New", "O : Morgan Stanley Active Assets (1)"). None of
 * that is part of the asset name.
 *
 * Two cuts handle it, because an asset name never contains either mark: the
 * last colon ends an annotation label, and a parenthesised digit ends an owner
 * account number. Whatever survives both is the asset.
 */
export function cleanAsset(raw: string): string {
  let s = raw;
  const q = s.lastIndexOf('?');           // end of the "Cap. Gains > $200?" header
  if (q !== -1) s = s.slice(q + 1);
  const c = s.lastIndexOf(':');           // end of an annotation label
  if (c !== -1) s = s.slice(c + 1);
  const acct = /\(\d+\)(?!\s*$)/g;      // owner account marker, e.g. "(1)"
  let m: RegExpExecArray | null, last = -1;
  while ((m = acct.exec(s)) !== null) last = m.index + m[0].length;
  if (last !== -1) s = s.slice(last);
  return s.replace(/\s+/g, ' ').trim();
}
const FILER = /Name:\s*((?:Hon\.|Mr\.|Mrs\.|Ms\.|Dr\.)?\s*[^\n]{2,60}?)\s{2,}(?:Status|State)/;
const FILING_ID = /Filing ID\s*#?\s*(\d{6,})/;

export interface PtrTransaction {
  asset: string;
  ticker: string | null;
  assetType: string;
  action: string;
  transactionDate: string;
  notificationDate: string;
  amount: string;
}

export interface PtrParse {
  filer: string | null;
  filingId: string | null;
  transactions: PtrTransaction[];
  /** True when the PDF carried no usable text - almost always a scan. */
  unreadable: boolean;
  charCount: number;
}

/**
 * Pull the transactions out of one filing's extracted text.
 *
 * The header labels in these PDFs are set in letter-spaced small caps, so they
 * extract as "F I" and "T" rather than "Filer Information" and "Transactions".
 * Nothing here depends on them; only the data rows are read.
 */
export function parsePtrText(text: string): PtrParse {
  const clean = text.replace(/ /g, ' ');
  // A filing with a text layer but no transaction table is a valid empty
  // report, not an unreadable one. Only the absence of text means a scan.
  const unreadable = clean.replace(/\s+/g, '').length < 120;

  const transactions: PtrTransaction[] = [];
  for (const m of clean.matchAll(ROW)) {
    const rawAsset = cleanAsset(m[1] ?? '');
    const t = rawAsset.match(TICKER);
    transactions.push({
      asset: rawAsset,
      ticker: t?.[1] ?? null,
      assetType: m[2] ?? '',
      action: m[3] ?? '',
      transactionDate: m[4] ?? '',
      notificationDate: m[5] ?? '',
      amount: (m[6] ?? '').replace(/\s+/g, ' ').trim(),
    });
  }

  const filer = clean.match(FILER)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    filer,
    filingId: clean.match(FILING_ID)?.[1] ?? null,
    transactions,
    unreadable,
    charCount: clean.length,
  };
}

/**
 * Extract the text layer of a PDF.
 *
 * pdfjs is loaded lazily so the CLI's other commands do not pay for it, and so
 * a machine that never parses a filing never loads a PDF engine at all.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: bytes,
    useSystemFonts: true,
    // These are public forms; nothing should be fetched from the network to
    // render one, and a filing must never be able to make us issue a request.
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  await doc.destroy();
  return out;
}

/** Turn one parsed filing into rows the CSV importer's normaliser accepts. */
export function ptrToTradeRows(
  parse: PtrParse,
  fallbackFiler: string | null,
  filingDate: string | null,
): Record<string, string>[] {
  const filer = parse.filer ?? fallbackFiler ?? '';
  return parse.transactions.map((t) => ({
    representative: filer,
    ticker: t.ticker ?? '',
    asset_description: t.asset,
    type: t.action,
    transaction_date: t.transactionDate,
    // The notification date is when the filer says they learned of it; the
    // filing date is when the Clerk received the report. The deadline runs to
    // the filing, so that is what the lag is measured against.
    disclosure_date: filingDate ?? t.notificationDate,
    amount: t.amount,
  }));
}

export interface FetchPtrResult {
  docId: string;
  trades: TradeRecord[];
  unreadable: boolean;
  dropped: string[];
  error: string | null;
}

/** Fetch one filing and parse it into trade records. */
export async function fetchPtr(
  cfg: Config,
  opts: { docId: string; year: string | number; filer?: string | null; filingDate?: string | null; chamber?: Chamber },
): Promise<FetchPtrResult> {
  const out: FetchPtrResult = {
    docId: opts.docId, trades: [], unreadable: false, dropped: [], error: null,
  };
  try {
    const res = await politeFetch(ptrPdfUrl(opts.year, opts.docId), cfg);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parse = parsePtrText(await pdfText(new Uint8Array(await res.arrayBuffer())));
    out.unreadable = parse.unreadable;
    if (parse.unreadable) return out;

    const rows = ptrToTradeRows(parse, opts.filer ?? null, opts.filingDate ?? null);
    if (rows.length === 0) return out;

    const cols = mapColumns(Object.keys(rows[0] as Record<string, string>));
    for (const raw of rows) {
      const rec = normalizeRow(raw, cols, { chamber: opts.chamber ?? 'house' });
      if ('skipped' in rec) out.dropped.push(rec.skipped);
      else out.trades.push(rec);
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}
