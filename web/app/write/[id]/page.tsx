import { notFound } from 'next/navigation';
import { db } from '../../../lib/db';
import { buildLedger, renderLedgerMarkdown, USAGE_RULE, tally } from '../../../../dist/pipeline/ledger.js';
import { guardsFor, renderWriterBrief } from '../../../../dist/pipeline/writer-brief.js';
import CopyCard from '../../item/[id]/copy-card';

export const dynamic = 'force-dynamic';

const STAMP: Record<string, string> = {
  record: 'stamp-hi',
  pattern: 'stamp-hi',
  reported: 'stamp-plain',
  alleged: 'stamp-red',
  speculated: 'stamp-plain',
  overlap: 'stamp-plain',
  hypothesis: 'stamp-red',
  background: 'stamp-plain',
};

/**
 * The ledger and the lines not to cross for one subject.
 *
 * Both are assembled in code from what is on file, so this page costs nothing
 * and cannot say anything the database does not. The prose half of the brief
 * is a model call and belongs to the CLI: `all-int brief:writer <id>`.
 */
export default async function WriteSubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ledger = buildLedger(db(), id);
  if (!ledger) notFound();

  const guards = guardsFor(ledger);
  const counts = tally(ledger);
  const briefMd = renderWriterBrief(ledger, guards, null);
  const ledgerMd = renderLedgerMarkdown(ledger);

  return (
    <>
      <section className="sheet">
        <div className="sheet-head">
          <span className="num">W.</span>
          <h2>Writer brief</h2>
          <span className="stamp stamp-plain">{ledger.subject.kind === 'thread' ? 'Storyline' : 'Item'}</span>
        </div>

        <div className="formfield">
          <span className="fnum">70.</span>
          <div className="fbody">
            <span className="flabel">Subject</span>
            <h3 style={{ fontSize: '1.3rem', lineHeight: 1.25, textTransform: 'uppercase', marginBottom: 8 }}>
              {ledger.subject.title}
            </h3>
            {ledger.subject.kind === 'item'
              ? <a href={`/item/${ledger.subject.id}`}>Item record &rarr;</a>
              : null}
          </div>
        </div>

        <div className="formfield">
          <span className="fnum">71.</span>
          <div className="fbody">
            <span className="flabel">What this ledger is made of</span>
            <div className="filters" style={{ marginTop: 6 }}>
              {(Object.entries(counts) as Array<[string, number]>)
                .filter(([, n]) => n > 0)
                .map(([standing, n]) => (
                  <span key={standing} className={`stamp ${STAMP[standing] ?? 'stamp-plain'}`}>
                    {standing} &times;{n}
                  </span>
                ))}
            </div>
          </div>
        </div>

        <div className="formfield">
          <span className="fnum">72.</span>
          <div className="fbody">
            <span className="flabel">Take it with you</span>
            <CopyCard text={briefMd} label="Copy the brief as markdown" />
            <p className="instruction" style={{ borderBottom: 'none', paddingBottom: 0, marginTop: 10 }}>
              The flat prose half &mdash; lede, what the record shows, what is open &mdash; is a
              model call and runs from the terminal: <code>all-int brief:writer {ledger.subject.id}</code>.
              Every line it writes cites rows below; lines citing nothing are struck before you
              see them.
            </p>
          </div>
        </div>
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">X.</span>
          <h2>Lines not to cross</h2>
        </div>
        <p className="instruction">
          Derived from the standing of each row, not from a reading of the subject. The same
          rows give the same lines every time.
        </p>
        {guards.map((g, i) => (
          <div className="assess" key={i}><b>{String(i + 1).padStart(2, '0')}</b>{g}</div>
        ))}
      </section>

      <section className="sheet">
        <div className="sheet-head">
          <span className="num">Y.</span>
          <h2>Ledger</h2>
          <span className="stamp stamp-hi">{ledger.rows.length} claims</span>
        </div>
        <p className="instruction">
          Every claim on file for this subject. Standing is a property of the record behind the
          row &mdash; a filing, an outlet, a detector&rsquo;s join, a model&rsquo;s proposal &mdash;
          not a judgement about the claim.
          {ledger.struck > 0 ? <> {ledger.struck} connection{ledger.struck === 1 ? '' : 's'} you judged coincidence or wrong {ledger.struck === 1 ? 'is' : 'are'} left off.</> : null}
        </p>
        {ledger.rows.length === 0 ? (
          <p className="empty">Nothing on file yet. Extract this subject first: <code>all-int investigate {ledger.subject.id}</code>.</p>
        ) : (
          <div className="tscroll">
            <table>
              <thead>
                <tr><th>#</th><th>Date</th><th>Standing</th><th>Claim</th><th>Source</th><th>Would be wrong if</th></tr>
              </thead>
              <tbody>
                {ledger.rows.map((r) => (
                  <tr key={r.ref}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.ref}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.date ?? <span className="redacted">undated</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={`stamp ${STAMP[r.standing] ?? 'stamp-plain'}`}>{r.standing}</span>
                      {r.confidence !== null ? <> {r.confidence.toFixed(2)}</> : null}
                    </td>
                    <td>{r.claim}</td>
                    <td>
                      {r.url
                        ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.source}</a>
                        : r.source}
                    </td>
                    <td>{r.falsifier ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          {(Object.entries(USAGE_RULE) as Array<[string, string]>)
            .filter(([standing]) => counts[standing as keyof typeof counts] > 0)
            .map(([standing, rule]) => (
              <div className="assess" key={standing}><b>{standing}</b>{rule}</div>
            ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <CopyCard text={ledgerMd} label="Copy the ledger as markdown" />
        </div>
      </section>
    </>
  );
}
