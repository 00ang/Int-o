import { db } from '../../lib/db';
import { suggestTopics } from '../../../dist/pipeline/topics.js';

export const dynamic = 'force-dynamic';

/**
 * What is ready to be written about.
 *
 * Read-only and free: the ranking is computed in code from what is on file,
 * and every suggestion shows the counts it was ranked on and the gaps it has,
 * so the order can be argued with.
 */
export default async function WritePage() {
  const topics = suggestTopics(db(), { limit: 20 });

  return (
    <section className="sheet">
      <div className="sheet-head">
        <span className="num">W.</span>
        <h2>Subjects ready to write</h2>
        <span className="stamp stamp-hi">{topics.length} suggested</span>
      </div>
      <p className="instruction">
        Storylines and retained items ranked by how much of them the records let you state:
        patterns the detectors joined, documented events, independent sources, and how recently
        the subject moved. A story one outlet reported once scores near nothing, however large
        the headline. <b>The suggestion is where to look.</b> What the piece may say is on each
        subject&rsquo;s ledger.
      </p>

      {topics.length === 0 ? (
        <p className="empty">
          Nothing to suggest: no storyline or retained item has a stateable record in it yet.
          Run <code>all-int extract</code>, then <code>all-int link</code>.
        </p>
      ) : topics.map((t, i) => (
        <article className="record" key={t.subject.id}>
          <div className="rec-top">
            <span className={`stamp ${t.basis.patterns > 0 ? 'stamp-hi' : 'stamp-plain'}`}>
              {t.subject.kind === 'thread' ? 'Storyline' : 'Item'}
            </span>
            <span className="refno">
              RANK {String(i + 1).padStart(2, '0')} &middot; score {t.score.toFixed(1)}
            </span>
          </div>
          <h3 className="rec-topic"><a href={`/write/${t.subject.id}`}>{t.subject.title}</a></h3>
          <p className="rec-title">{t.pitch}</p>
          {t.angle ? (
            <p className="hilite"><b>Open with</b><span>{t.angle}</span></p>
          ) : null}
          {t.gaps.length ? (
            <p className="assess"><b>Gaps</b>{t.gaps.join('; ')}</p>
          ) : null}
          <div className="rec-foot">
            <a className="digdeeper" href={`/write/${t.subject.id}`}>Ledger and writer brief &rarr;</a>
            {t.subject.kind === 'item' ? <a href={`/item/${t.subject.id}`}>Item record</a> : null}
          </div>
        </article>
      ))}
    </section>
  );
}
