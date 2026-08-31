import { queue, stats, type Verdict } from '../lib/queries';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'notable', label: 'Notable' },
  { key: 'worth-a-look', label: 'Worth a look' },
  { key: 'primary', label: 'Primary only' },
];

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ v?: string; q?: string }> }) {
  const sp = await searchParams;
  const v = sp.v ?? '';
  const rows = queue({
    verdict: v === 'notable' || v === 'worth-a-look' ? (v as Verdict) : undefined,
    tier: v === 'primary' ? 'primary' : undefined,
    q: sp.q || undefined,
  });
  const s = stats();

  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">1.</span>
          <h2>Summary of holdings</h2>
        </div>
        <div className="grid">
          <div className="cell"><b>{s.items.toLocaleString()}</b><span>Items held</span></div>
          <div className="cell"><b>{s.judged.toLocaleString()}</b><span>Judged</span></div>
          <div className="cell"><b>{s.kept}</b><span>Retained</span></div>
          <div className="cell"><b>{s.notable}</b><span>Notable</span></div>
          <div className="cell"><b>{s.events}</b><span>Events</span></div>
          <div className="cell"><b>{s.sourcesLive}</b><span>Live feeds</span></div>
        </div>
        <p className="instruction" style={{ marginTop: 15, marginBottom: 0, borderBottom: 'none', paddingBottom: 0 }}>
          {s.untriaged.toLocaleString()} items remain unread. Everything listed below survived
          triage; the remainder was discarded as routine and costs nothing further. Absence from
          this queue is not evidence of absence in the world.
        </p>
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">2.</span>
          <h2>Items retained for review</h2>
          <span className="stamp stamp-hi">{rows.length} sheets</span>
        </div>

        <form className="searchform" action="/" method="get">
          <input type="search" name="q" defaultValue={sp.q ?? ''} placeholder="Filter by party, topic, angle&hellip;" aria-label="Filter the queue" />
          {v ? <input type="hidden" name="v" value={v} /> : null}
          <button className="btn btn-go" type="submit">Filter</button>
        </form>

        <div className="filters" style={{ marginTop: 12, marginBottom: 18 }}>
          {FILTERS.map((f) => {
            const href = f.key ? `/?v=${f.key}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`
                               : `/${sp.q ? `?q=${encodeURIComponent(sp.q)}` : ''}`;
            return (
              <a key={f.label} href={href} aria-current={v === f.key ? 'true' : undefined}>
                <span>{f.label}</span>
              </a>
            );
          })}
        </div>

        {rows.length === 0 ? <p className="empty">No items match.</p> : (
          <div>
            {rows.map((r, i) => (
              <article className="record" key={r.id}>
                <div className="rec-top">
                  <span className={`stamp ${r.verdict === 'notable' ? 'stamp-red' : 'stamp-hi'}`}>
                    {r.verdict === 'notable' ? 'Notable' : 'Worth a look'}
                  </span>
                  <span className="refno">
                    REF {String(i + 1).padStart(3, '0')} &middot; {r.publishedAt.slice(0, 10)}
                  </span>
                  {r.extracted ? <span className="stamp stamp-plain">Extracted</span> : null}
                </div>
                <h3 className="rec-topic"><a href={`/item/${r.id}`}>{r.topic}</a></h3>
                <p className="rec-title">{r.title}</p>
                {r.angle ? (
                  <p className="hilite"><b>Angle &mdash; check next</b><span>{r.angle}</span></p>
                ) : null}
                <p className="assess"><b>Assessment</b>{r.reason}</p>
                <div className="rec-foot">
                  <a className="digdeeper" href={`/item/${r.id}#map`}>Dig deeper &rarr;</a>
                  <span className="tier">{r.tier}</span>
                  <span>{r.source}</span>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">Original record</a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
