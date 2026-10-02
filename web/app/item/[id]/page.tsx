import { notFound } from 'next/navigation';
import { dossiersForItem, item, eventsForItem, connectionsForItem } from '../../../lib/queries';
import InvestigateButton from './investigate';
import Circled from '../../circled';
import Network from './network';
import DossierPanel from '../../dossier-panel';
import CopyCard from './copy-card';
import { db } from '../../../lib/db';
import { buildCard } from '../../../../dist/pipeline/card.js';

export const dynamic = 'force-dynamic';

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const it = item(id);
  if (!it) notFound();

  const events = eventsForItem(id);
  const connections = connectionsForItem(id);
  const dossiers = dossiersForItem(id);
  // Read-only, from what is on file: making a card never spends anything.
  const card = buildCard(db(), id);
  // A contract, filing or disclosure row rather than an article: triage never
  // read it, so there is no verdict or angle to show.
  const isRecord = it.topic === 'structured record';

  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">A.</span>
          <h2>Item record</h2>
          <span className={`stamp ${isRecord ? 'stamp-plain' : it.verdict === 'notable' ? 'stamp-red' : 'stamp-hi'}`}>
            {isRecord ? 'Public record' : it.verdict === 'notable' ? 'Notable' : it.verdict === 'mundane' ? 'Routine' : 'Worth a look'}
          </span>
        </div>

        <div className="fieldblock" style={{ marginBottom: 16 }}>
          <div><b>Ref</b> {it.id.replace('item_', '').slice(0, 12).toUpperCase()}</div>
          <div><b>Date</b> {it.publishedAt.slice(0, 10)}</div>
          <div><b>Tier</b> {it.tier}</div>
          <div><b>Sour</b> {it.source}</div>
        </div>

        <div className="formfield">
          <span className="fnum">40.</span>
          <div className="fbody">
            <span className="flabel">Subject</span>
            <h3 style={{ fontSize: '1.3rem', lineHeight: 1.25, textTransform: 'uppercase', marginBottom: 8 }}>
              {isRecord ? it.title : it.topic}
            </h3>
            {isRecord ? null : <p className="rec-title" style={{ marginBottom: 8 }}>{it.title}</p>}
            <a href={it.url} target="_blank" rel="noopener noreferrer">Original record &rarr;</a>
          </div>
        </div>

        {it.angle ? (
          <div className="formfield">
            <span className="fnum">41.</span>
            <div className="fbody">
              <span className="flabel">Matter flagged for check</span>
              <p className="hilite" style={{ marginTop: 4 }}>
                <Circled><span>{it.angle}</span></Circled>
              </p>
            </div>
          </div>
        ) : null}

        <div className="formfield">
          <span className="fnum">42.</span>
          <div className="fbody">
            <span className="flabel">{isRecord ? 'How it was read' : 'Basis for retention'}</span>
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              {isRecord
                ? 'A filing or dataset row, read field by field in code. No model was involved; every event below is what the record states.'
                : it.reason}
            </p>
          </div>
        </div>

        {card ? (
          <div className="formfield">
            <span className="fnum">43.</span>
            <div className="fbody">
              <span className="flabel">For the group chat</span>
              <CopyCard text={card} />
            </div>
          </div>
        ) : null}

        <div className="formfield">
          <span className="fnum">44.</span>
          <div className="fbody">
            <span className="flabel">For writing about it</span>
            <a className="digdeeper" href={`/write/${it.id}`}>Ledger and writer brief &rarr;</a>
          </div>
        </div>
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">B.</span>
          <h2>Who these parties are</h2>
          <span className={`stamp ${dossiers.length > 0 ? 'stamp-hi' : 'stamp-plain'}`}>
            {dossiers.length} dossier{dossiers.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="instruction">
          Background on the parties this record names, held independently of what the record
          asserts. An event involving a name carries no weight; the same event involving a party
          with a known position does. Claims marked <b>unverified</b> come from model training
          rather than from a record here.
        </p>
        {dossiers.length === 0 ? (
          <p className="instruction" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            No dossiers for these parties yet. Write them by running{' '}
            <code>all-int profile</code> in a terminal &mdash; it works from any directory and
            loads the project&rsquo;s settings itself.
          </p>
        ) : dossiers.map((d) => (
          <div key={d.entityId} style={{ borderTop: '2px solid var(--rule)', paddingTop: 14, marginTop: 14 }}>
            <h3 style={{ textTransform: 'uppercase', fontSize: '1.05rem', marginBottom: 4 }}>
              <a href={`/entity/${encodeURIComponent(d.slug)}`}>{d.name}</a>{' '}
              <span style={{ fontWeight: 400, color: 'var(--toner-3)', fontSize: '0.76rem' }}>
                [{d.kind}]
              </span>
            </h3>
            <DossierPanel dossier={d} name={d.name} compact />
          </div>
        ))}
      </section>

      <section className="sheet" id="map">
        <div className="sheet-head">
          <span className="num">C.</span>
          <h2>Association map</h2>
        </div>
        <p className="instruction">
          Fires the network from this story&rsquo;s parties and lets energy travel. The centre is
          this item; each ring outward is one degree of separation. What matters is the outer
          rings &mdash; parties this story never names, reached only through intermediaries, which
          no query over events can return. A path is structural proximity, not evidence: every
          chain is kept so it can be walked and thrown out.
        </p>
        <Network id={it.id} />
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">D.</span>
          <h2>Investigation</h2>
        </div>
        <p className="instruction">
          Nothing below runs on its own. Pressing this pulls the item&rsquo;s parties, searches the
          full corpus for anything else touching them, and runs the deterministic detectors scoped
          to this story. <b>Finding nothing is the common outcome and a real answer.</b>
        </p>
        <InvestigateButton id={it.id} hasEvents={events.length > 0} />
      </section>

      {events.length > 0 ? (
        <section className="sheet">
          <div className="sheet-head"><span className="num">E.</span><h2>Events extracted</h2></div>
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
          <div className="sheet-head"><span className="num">F.</span><h2>Connections</h2></div>
          {connections.map((c) => (
            <article className="record" key={c.id}>
              <div className="rec-top">
                <span className={`stamp ${c.basis === 'deterministic' ? 'stamp-hi' : 'stamp-plain'}`}>
                  {c.basis}
                </span>
                <span className="refno">
                  confidence {c.confidence.toFixed(2)} &middot; lag {Math.round(c.lagDays)}d &middot; {c.kind}
                </span>
              </div>
              <p className="rec-title" style={{ color: 'var(--carbon)' }}>{c.explanation}</p>
              <div className="assess"><b>A</b>{c.fromSummary}</div>
              <div className="assess"><b>B</b>{c.toSummary}</div>
              {c.falsifier ? <div className="hilite"><b>Would falsify</b><span>{c.falsifier}</span></div> : null}
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}
