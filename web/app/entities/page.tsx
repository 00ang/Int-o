import { topEntities } from '../../lib/queries';
export const dynamic = 'force-dynamic';

export default async function Entities() {
  const rows = topEntities(60);
  return (
    <section className="sheet">
      <div className="sheet-head"><span className="num">3.</span><h2>Parties on file</h2></div>
      <p className="note">
        Every party the extractor has resolved, by how often it appears. Names are canonicalised,
        so &ldquo;Lockheed Martin Corp.&rdquo; and &ldquo;Lockheed Martin&rdquo; are one party.
      </p>
      {rows.length === 0 ? <p className="empty">No parties resolved yet. Run extract.</p> : (
        <div className="tscroll">
          <table>
            <thead><tr><th>Party</th><th>Kind</th><th className="n">Events</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td><a href={`/entity/${encodeURIComponent(e.slug)}`}>{e.name}</a></td>
                  <td>{e.kind}</td>
                  <td className="n">{e.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
