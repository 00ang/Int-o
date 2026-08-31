import { notFound } from 'next/navigation';
import { entityBySlug, eventsForEntity } from '../../../lib/queries';
export const dynamic = 'force-dynamic';

export default async function EntityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ent = entityBySlug(decodeURIComponent(slug));
  if (!ent) notFound();
  const events = eventsForEntity(ent.id);

  return (
    <section className="sheet">
      <div className="sheet-head">
        <span className="num">P.</span><h2>{ent.name}</h2>
        <span className="stamp stamp-purple">{ent.kind}</span>
      </div>
      <p className="note">What this party has been involved in, newest first. Role is how they
        figured in each event &mdash; who acted, who gained, who was regulated.</p>
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
  );
}
