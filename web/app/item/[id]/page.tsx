import { notFound } from 'next/navigation';
import { item, eventsForItem, connectionsForItem } from '../../../lib/queries';
import InvestigateButton from './investigate';

export const dynamic = 'force-dynamic';

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const it = item(id);
  if (!it) notFound();

  const events = eventsForItem(id);
  const connections = connectionsForItem(id);

  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">A.</span>
          <h2>Item record</h2>
          <span className={`stamp ${it.verdict === 'notable' ? 'stamp-red' : 'stamp-blue'}`}>
            {it.verdict === 'notable' ? 'Notable' : 'Worth a look'}
          </span>
        </div>
        <div className="formline" style={{ marginBottom: 16 }}>
          <span>Ref <b>{it.id.replace('item_', '').slice(0, 12).toUpperCase()}</b></span>
          <span>Dated <b>{it.publishedAt.slice(0, 10)}</b></span>
          <span>Source <b>{it.source}</b></span>
          <span>Tier <b>{it.tier}</b></span>
        </div>
        <h3 style={{ fontSize: '1.35rem', lineHeight: 1.25, marginBottom: 10 }}>{it.topic}</h3>
        <p className="rec-title" style={{ fontSize: '1rem' }}>{it.title}</p>
        <p style={{ margin: '0 0 16px' }}>
          <a href={it.url} target="_blank" rel="noopener noreferrer">Open the original record &rarr;</a>
        </p>
        {it.angle ? <div className="field"><b>Angle &mdash; check next</b>{it.angle}</div> : null}
        <div className="field assess"><b>Why it was retained</b>{it.reason}</div>
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">B.</span>
          <h2>Investigation</h2>
        </div>
        <p className="note">
          Nothing below runs on its own. Pressing this pulls the item&rsquo;s parties, searches the
          full corpus for anything else touching them, and runs the deterministic detectors scoped
          to this story. <b>Finding nothing is the common outcome and a real answer.</b>
        </p>
        <InvestigateButton id={it.id} hasEvents={events.length > 0} />
      </section>

      {events.length > 0 ? (
        <section className="sheet">
          <div className="sheet-head"><span className="num">C.</span><h2>Events extracted</h2></div>
          <div className="tscroll">
            <table>
              <thead><tr><th>Occurred</th><th>Type</th><th>Assertion</th><th>Summary</th><th>Parties</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.occurredAt.slice(0, 10)}</td>
                    <td>{e.type}</td>
                    <td>{e.assertion}</td>
                    <td>{e.summary}</td>
                    <td>{e.parties || <span className="redacted">not stated</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {connections.length > 0 ? (
        <section className="sheet">
          <div className="sheet-head"><span className="num">D.</span><h2>Connections</h2></div>
          {connections.map((c) => (
            <article className="record" key={c.id}>
              <div className="rec-top">
                <span className={`stamp ${c.basis === 'deterministic' ? 'stamp-purple' : 'stamp-plain'}`}>
                  {c.basis}
                </span>
                <span className="refno">
                  confidence {c.confidence.toFixed(2)} &middot; lag {Math.round(c.lagDays)}d &middot; {c.kind}
                </span>
              </div>
              <p className="rec-title" style={{ color: 'var(--carbon)' }}>{c.explanation}</p>
              <div className="field assess"><b>A</b>{c.fromSummary}</div>
              <div className="field assess"><b>B</b>{c.toSummary}</div>
              {c.falsifier ? <div className="field"><b>Would falsify</b>{c.falsifier}</div> : null}
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}
