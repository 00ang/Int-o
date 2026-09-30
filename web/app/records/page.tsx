import { recordCounts, records, type RecordKind } from '../../lib/queries';

export const dynamic = 'force-dynamic';

const KINDS: Array<{ key: '' | RecordKind; label: string }> = [
  { key: '', label: 'All' },
  { key: 'insider', label: 'Insider trades' },
  { key: 'congress', label: 'Congress trades' },
  { key: 'lobbying', label: 'Lobbying' },
  { key: 'contracts', label: 'Contracts' },
];

const STAMP: Record<RecordKind, string> = {
  insider: 'Insider',
  congress: 'Congress',
  lobbying: 'Lobbying',
  contracts: 'Contract',
};

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`;

export default async function RecordsPage({
  searchParams,
}: { searchParams: Promise<{ k?: string; q?: string; sort?: string }> }) {
  const sp = await searchParams;
  const kind = KINDS.some((k) => k.key === sp.k && k.key !== '') ? (sp.k as RecordKind) : undefined;
  const sort = sp.sort === 'biggest' ? 'biggest' : 'newest';
  const rows = records({ kind, q: sp.q || undefined, sort });
  const counts = recordCounts();

  const href = (over: { k?: string; sort?: string }) => {
    const u = new URLSearchParams();
    const k = over.k ?? sp.k ?? '';
    const s = over.sort ?? sort;
    if (k) u.set('k', k);
    if (s !== 'newest') u.set('sort', s);
    if (sp.q) u.set('q', sp.q);
    const qs = u.toString();
    return `/records${qs ? `?${qs}` : ''}`;
  };

  return (
    <section className="sheet">
      <div className="sheet-head">
        <span className="num">R.</span>
        <h2>Public records</h2>
        <span className="stamp stamp-hi">{rows.length} shown</span>
      </div>
      <p className="instruction">
        Money moving, read straight from the filings: insiders buying and selling their own
        company&rsquo;s stock, members of Congress trading, who paid whom to lobby, and new federal
        contracts. No model reads these; each line is what the record states. <b>Linked</b> means
        the detectors joined it to another record &mdash; open those first.
      </p>

      <form className="searchform" action="/records" method="get">
        <input type="search" name="q" defaultValue={sp.q ?? ''} placeholder="Filter by name, ticker, agency, bill&hellip;" aria-label="Filter records" />
        {sp.k ? <input type="hidden" name="k" value={sp.k} /> : null}
        {sort !== 'newest' ? <input type="hidden" name="sort" value={sort} /> : null}
        <button className="btn btn-go" type="submit">Filter</button>
      </form>

      <div className="filters" style={{ marginTop: 12, marginBottom: 8 }}>
        {KINDS.map((k) => (
          <a key={k.label} href={href({ k: k.key })} aria-current={(sp.k ?? '') === k.key ? 'true' : undefined}>
            <span>{k.label}{k.key ? ` (${counts[k.key].toLocaleString()})` : ''}</span>
          </a>
        ))}
      </div>
      <div className="filters" style={{ marginBottom: 18 }}>
        <a href={href({ sort: 'newest' })} aria-current={sort === 'newest' ? 'true' : undefined}><span>Newest</span></a>
        <a href={href({ sort: 'biggest' })} aria-current={sort === 'biggest' ? 'true' : undefined}><span>Biggest</span></a>
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          No records yet. Run <code>all-int ingest</code> to fetch insider filings, lobbying and
          contracts, or <code>all-int ptr:fetch</code> for congressional trades.
        </p>
      ) : rows.map((r) => {
        const tags = JSON.parse(r.tags || '[]') as string[];
        return (
          <article className="record" key={r.id}>
            <div className="rec-top">
              <span className="stamp stamp-plain">{STAMP[r.kind]}</span>
              {r.linked > 0 ? <span className="stamp stamp-red">Linked &times;{r.linked}</span> : null}
              {tags.includes('revolving-door') ? <span className="stamp stamp-hi">Revolving door</span> : null}
              {tags.includes('late-filing') ? <span className="stamp stamp-hi">Filed late</span> : null}
              {tags.includes('10b5-1') ? <span className="stamp stamp-plain">10b5-1 plan</span> : null}
              <span className="refno">
                {r.occurredAt.slice(0, 10)}{r.amount ? <> &middot; {usd(r.amount)}</> : null}
              </span>
            </div>
            <p className="rec-title" style={{ color: 'var(--carbon)' }}>{r.summary}</p>
            <div className="rec-foot">
              <a className="digdeeper" href={`/item/${r.itemId}`}>Open &amp; share &rarr;</a>
              {/^https?:\/\//.test(r.url)
                ? <a href={r.url} target="_blank" rel="noopener noreferrer">Original filing</a>
                : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
