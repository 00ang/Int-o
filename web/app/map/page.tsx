import { graphStats } from '../../lib/queries';
import MapPanel from './panel';

export const dynamic = 'force-dynamic';

export default async function MapPage() {
  const g = graphStats();
  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">1.</span>
          <h2>Association map</h2>
          <span className="stamp stamp-hi">{g.edges} links</span>
        </div>
        <p className="instruction">
          Every party the corpus has wired to another, and why. An edge means two parties appeared
          in one event, one document, or one storyline &mdash; in descending strength. It records
          co-occurrence, never relationship: two parties named in one filing are joined here
          whether they are counterparties or strangers who landed on the same page.
        </p>
        <div className="grid" style={{ marginBottom: 18 }}>
          <div className="cell"><b>{g.nodes}</b><span>Parties wired</span></div>
          <div className="cell"><b>{g.edges}</b><span>Links</span></div>
          <div className="cell"><b>{g.domainLinks}</b><span>Party-topic links</span></div>
          <div className="cell"><b>{g.avgDegree.toFixed(1)}</b><span>Links per party</span></div>
        </div>
        <MapPanel />
      </section>

      <section className="sheet">
        <div className="sheet-head"><span className="num">2.</span><h2>How to read it</h2></div>
        <div className="formfield">
          <span className="fnum">40.</span>
          <div className="fbody">
            <span className="flabel">What a link is</span>
            Two parties named in the same event, the same document, or the same storyline. Weight
            rises with how central each party was to the event, how good the source is, and how
            recently it happened.
          </div>
        </div>
        <div className="formfield">
          <span className="fnum">41.</span>
          <div className="fbody">
            <span className="flabel">What a link is not</span>
            Evidence of anything. A path through this map is exactly as innocent as
            co-occurrence. The map exists so a question can travel further than a database join
            can reach, and every route it finds is kept so a person can walk it and dismiss it.
          </div>
        </div>
        <div className="formfield">
          <span className="fnum">42.</span>
          <div className="fbody">
            <span className="flabel">Firing it</span>
            Open any item in the queue and press <b>Fire the network</b>. That seeds this map with
            the story&rsquo;s own parties and lets energy travel outward. The parties worth your
            attention are the ones on the outer rings &mdash; reached only through an
            intermediary, never named beside the story anywhere.
          </div>
        </div>
      </section>
    </>
  );
}
