import { search } from '../../lib/queries';
export const dynamic = 'force-dynamic';

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  let rows: ReturnType<typeof search> = [];
  let error = '';
  if (q) {
    try { rows = search(q); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  return (
    <section className="sheet">
      <div className="sheet-head"><span className="num">4.</span><h2>Search the holdings</h2></div>
      <p className="note">
        Full text over every item ingested, judged or not. This reaches material the event
        detectors cannot see: an item nobody has extracted is invisible to a query over events,
        but it is still on file.
      </p>
      <form className="searchform" action="/search" method="get">
        <input type="search" name="q" defaultValue={q ?? ''} placeholder="Party, phrase, docket number&hellip;" aria-label="Search all items" />
        <button className="btn btn-go" type="submit">Search</button>
      </form>
      {error ? <div className="field" style={{ borderLeftColor: 'var(--stamp)', marginTop: 16 }}><b style={{ color: 'var(--stamp)' }}>Query rejected</b>{error}</div> : null}
      {q && !error ? (
        rows.length === 0 ? <p className="empty">Nothing on file matches &ldquo;{q}&rdquo;.</p> : (
          <div className="tscroll" style={{ marginTop: 18 }}>
            <table>
              <thead><tr><th>Date</th><th>Verdict</th><th>Title</th><th>Source</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.publishedAt.slice(0, 10)}</td>
                    <td>{r.verdict ?? <span className="refno">unread</span>}</td>
                    <td><a href={`/item/${r.id}`}>{r.topic ?? r.title}</a></td>
                    <td>{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
