import { notFound } from 'next/navigation';
import { dossier, entityBySlug, eventsForEntity } from '../../../lib/queries';
import DossierPanel from '../../dossier-panel';

export const dynamic = 'force-dynamic';

export default async function EntityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ent = entityBySlug(decodeURIComponent(slug));
  if (!ent) notFound();
  const events = eventsForEntity(ent.id);
  const d = dossier(ent.id);

  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">1.</span>
          <h2>{ent.name}</h2>
          <span className="stamp stamp-hi">{ent.kind}</span>
          {!d && <span className="stamp stamp-plain">no dossier</span>}
        </div>

        {d ? (
          <>
            <p className="instruction">
              Background on this party, held separately from anything a single record asserts.
              This is the prior a new event involving them is read against.
            </p>
            <DossierPanel dossier={d} name={ent.name} />
          </>
        ) : (
          <p className="instruction" style={{ borderBottom: 'none' }}>
            No dossier written yet. Without one this party is a name with {ent.events} event
            {ent.events === 1 ? '' : 's'} attached and no history, so nothing here can say whether
            those events are ordinary for them or not. Write one with{' '}
            <b>all-int profile</b>.
          </p>
        )}
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">2.</span>
          <h2>On the record here</h2>
          <span className="stamp stamp-red">{events.length} events</span>
        </div>
        <p className="instruction">
          What this corpus actually holds on them, newest first. Role is how they figured in each
          event &mdash; who acted, who gained, who was regulated.
        </p>
        {events.length === 0 ? <p className="empty">No events on file.</p> : (
          <div className="tscroll">
            <table>
              <thead><tr><th>Date</th><th>Role</th><th>Type</th><th>Summary</th><th>Source</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.occurredAt.slice(0, 10)}</td>
                    <td>{e.role}</td>
                    <td>{e.type}</td>
                    <td><a href={`/item/${e.itemId}`}>{e.summary}</a></td>
                    <td>{e.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
