import { describe, expect, it } from 'vitest';
import { cleanAsset, parsePtrText, ptrPdfUrl, ptrToTradeRows } from '../src/sources/ptr-pdf.js';

/**
 * Fixture text taken verbatim from the pdfjs extraction of filing 20035243
 * (Hon. Jared Moskowitz, filed 2026-08-27). The whitespace damage is real:
 * the form's letter-spaced small-cap headers extract as "F I" and "T", and the
 * filer's annotations land between the data rows. Anything that parses this
 * parses the real thing.
 */
const REAL = `P        T           R       Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515  F     I            Name:   Hon. Jared Moskowitz  Status:   Member  State/District:   FL23  T             ID   Owner   Asset   Transaction Type Date   Notification Date Amount   Cap. Gains > $200?  Applied Materials, Inc. - Common Stock (AMAT) [ST] P   07/13/2026   07/31/2026   $1,001 - $15,000  F      S     : New S          O : Morgan Stanley Active Assets (1)  STERIS plc (STE) [ST]   S   07/13/2026   07/31/2026   $1,001 - $15,000  F      S     : New S          O : Morgan Stanley Active Assets (1)  W.W. Grainger, Inc. Common Stock (GWW) [ST] S (partial)   07/13/2026   07/31/2026   $1,001 - $15,000  * For the complete list of asset type abbreviations, please visit   https://fd.house.gov/reference/asset-type-codes.aspx.  Filing ID #20035243`;

describe('PTR PDF parsing', () => {
  const parsed = parsePtrText(REAL);

  it('finds every transaction in the table', () => {
    expect(parsed.transactions).toHaveLength(3);
  });

  it('reads the tickers', () => {
    expect(parsed.transactions.map((t) => t.ticker)).toEqual(['AMAT', 'STE', 'GWW']);
  });

  it('keeps a partial sale distinguishable from a full one', () => {
    expect(parsed.transactions[2]!.action).toBe('S (partial)');
  });

  it('reads both dates and the amount band', () => {
    const t = parsed.transactions[0]!;
    expect(t.transactionDate).toBe('07/13/2026');
    expect(t.notificationDate).toBe('07/31/2026');
    expect(t.amount).toBe('$1,001 - $15,000');
  });

  it('reads the filer and the filing id through the damaged headers', () => {
    expect(parsed.filer).toBe('Hon. Jared Moskowitz');
    expect(parsed.filingId).toBe('20035243');
  });

  it('does not call a readable filing unreadable', () => {
    expect(parsed.unreadable).toBe(false);
  });

  // A scan has no text layer at all. That must be reported, never treated as
  // a filing with no trades in it.
  it('flags a filing with no text layer', () => {
    expect(parsePtrText('').unreadable).toBe(true);
    expect(parsePtrText('   \n  ').unreadable).toBe(true);
  });

  it('treats a readable filing with an empty table as readable, not a scan', () => {
    const empty = REAL.replace(/Applied Materials[\s\S]*asset-type-codes\.aspx\./, '');
    const p = parsePtrText(empty);
    expect(p.unreadable).toBe(false);
    expect(p.transactions).toHaveLength(0);
  });
});

describe('asset description cleaning', () => {
  it('drops the column headers that precede the first row', () => {
    expect(cleanAsset('FL23 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?  Applied Materials, Inc. - Common Stock (AMAT)'))
      .toBe('Applied Materials, Inc. - Common Stock (AMAT)');
  });

  it('drops an annotation label carried over from the previous row', () => {
    expect(cleanAsset('F S : New S O : Morgan Stanley Active Assets (1) STERIS plc (STE)'))
      .toBe('STERIS plc (STE)');
  });

  it('leaves a clean asset name alone', () => {
    expect(cleanAsset('W.W. Grainger, Inc. Common Stock (GWW)'))
      .toBe('W.W. Grainger, Inc. Common Stock (GWW)');
  });

  // The ticker itself is parenthesised; it must not be mistaken for an
  // owner-account marker and cut away.
  it('does not cut a parenthesised ticker', () => {
    expect(cleanAsset('Some Fund 2045 (XYZ)')).toBe('Some Fund 2045 (XYZ)');
  });
});

describe('handing PTR rows to the trade importer', () => {
  it('maps to the column names the CSV importer already understands', () => {
    const rows = ptrToTradeRows(parsePtrText(REAL), null, '8/27/2026');
    expect(rows[0]).toMatchObject({
      representative: 'Hon. Jared Moskowitz',
      ticker: 'AMAT',
      type: 'P',
      transaction_date: '07/13/2026',
      disclosure_date: '8/27/2026',
      amount: '$1,001 - $15,000',
    });
  });

  // The deadline runs from execution to filing, so the lag must be measured
  // against the Clerk's filing date, not the filer's own notification date.
  it('measures disclosure against the filing date, not the notification date', () => {
    const rows = ptrToTradeRows(parsePtrText(REAL), null, '8/27/2026');
    expect(rows[0]!.disclosure_date).toBe('8/27/2026');
    expect(rows[0]!.disclosure_date).not.toBe('07/31/2026');
  });

  it('falls back to the index filer when the PDF header is unreadable', () => {
    const noName = parsePtrText(REAL.replace('Name:   Hon. Jared Moskowitz  Status:', 'Status:'));
    const rows = ptrToTradeRows(noName, 'Hon. Fallback Member', '8/27/2026');
    expect(rows[0]!.representative).toBe('Hon. Fallback Member');
  });
});

describe('filing URLs', () => {
  it('builds the Clerk path for a filing', () => {
    expect(ptrPdfUrl(2026, '20035243'))
      .toBe('https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035243.pdf');
  });
});
