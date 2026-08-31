import { stats } from '../../lib/queries';
export const dynamic = 'force-dynamic';

export default async function Status() {
  const s = stats();
  const judgedByModel = s.judged - 300; // 300 market snapshots skip triage by design
  const keptPct = judgedByModel > 0 ? Math.round((s.kept / judgedByModel) * 100) : 0;
  return (
    <>
      <section className="sheet">
        <div className="sheet-head"><span className="num">5.</span><h2>Holdings and disposition</h2></div>
        <div className="grid">
          <div className="cell"><b>{s.items.toLocaleString()}</b><span>Items held</span></div>
          <div className="cell"><b>{s.untriaged.toLocaleString()}</b><span>Unread</span></div>
          <div className="cell"><b>{keptPct}%</b><span>Retained of judged</span></div>
          <div className="cell"><b>{s.events}</b><span>Events</span></div>
          <div className="cell"><b>{s.entities}</b><span>Parties</span></div>
          <div className="cell"><b>{s.connections}</b><span>Connections</span></div>
          <div className="cell"><b>{s.threads}</b><span>Storylines</span></div>
          <div className="cell"><b>{s.sourcesLive}</b><span>Live feeds</span></div>
        </div>
      </section>
      <section className="sheet">
        <div className="sheet-head"><span className="num">6.</span><h2>Standing limitations</h2></div>
        <p className="instruction">
          Recorded here rather than buried, because a system that hides its gaps is not an
          intelligence system.
        </p>
        <div className="assess"><b>Coverage</b>
          {s.untriaged.toLocaleString()} of {s.items.toLocaleString()} items have never been read.
          Absence from this queue is not evidence of absence in the world.
        </div>
        <div className="assess"><b>Duplicate coverage</b>
          Several outlets reporting one event are judged independently and appear as separate
          sheets. Collapsing them is storyline work and is not yet running.
        </div>
        <div className="assess"><b>Congressional trade detail</b>
          The House Clerk index gives who filed and when, never the ticker or size. Do not read the
          absence of trade detail as an absence of trading.
        </div>
      </section>
    </>
  );
}
