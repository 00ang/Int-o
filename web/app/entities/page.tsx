import { dossierCoverage, partiesWithDossiers, topEntities } from '../../lib/queries';
export const dynamic = 'force-dynamic';

export default async function Entities() {
  const rows = topEntities(60);
  const profiled = partiesWithDossiers();
  const cov = dossierCoverage();
  return (
    <section className="sheet">
      <div className="sheet-head"><span className="num">3.</span><h2>Parties on file</h2></div>
      <p className="instruction">
        Every party the extractor has resolved, by how often it appears. Names are canonicalised,
        so &ldquo;Lockheed Martin Corp.&rdquo; and &ldquo;Lockheed Martin&rdquo; are one party.
        A party without a dossier is a name with no history, and an event involving one cannot be
        read as ordinary or unusual. <b>{cov.written} of {cov.parties} have one.</b>
      </p>
      {rows.length === 0 ? <p className="empty">No parties resolved yet. Run all-int extract.</p> : (
        <div className="tscroll">
          <table>
            <thead><tr><th>Party</th><th>Kind</th><th className="n">Events</th><th>Dossier</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td><a href={`/entity/${encodeURIComponent(e.slug)}`}>{e.name}</a></td>
                  <td>{e.kind}</td>
                  <td className="n">{e.events}</td>
                  <td>{profiled.has(e.id)
                    ? <span className="stamp stamp-hi" style={{ transform: 'none' }}>on file</span>
                    : <span style={{ color: 'var(--toner-3)' }}>&mdash;</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
