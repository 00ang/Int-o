import type { ClaimBasis, Dossier } from '../lib/queries';

/**
 * A dossier, rendered as the form section it is.
 *
 * One thing carries the weight here: the basis mark on every claim. A dossier
 * is the only place in this system where outside knowledge is allowed in, and
 * the whole safety of that rests on a reader being able to tell a record from a
 * recollection at a glance. So `recalled` is set in the stamp ink and says
 * UNVERIFIED in words - not styled as a footnote, because a reader skimming
 * must not mistake it for a filing.
 *
 * Capabilities are given their own section rather than folded into history,
 * because they answer a different question: not what happened, but what is
 * within reach and what it would take. Each one shows the trace it would leave,
 * which is what keeps a possibility checkable instead of insinuating.
 */
const BASIS_LABEL: Record<ClaimBasis, string> = {
  corpus: 'on record here',
  recalled: 'unverified',
  inferred: 'inferred',
};

function Basis({ basis, confidence }: { basis: ClaimBasis; confidence: number }) {
  const recalled = basis === 'recalled';
  return (
    <span
      style={{
        fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '.1em',
        border: '1px solid currentColor', padding: '1px 5px', whiteSpace: 'nowrap',
        color: recalled ? 'var(--stamp)' : 'var(--toner-3)',
        borderStyle: recalled ? 'solid' : 'dashed',
      }}
    >
      {BASIS_LABEL[basis]} &middot; {confidence.toFixed(2)}
    </span>
  );
}

export default function DossierPanel(
  { dossier: d, name, compact = false }:
  { dossier: Dossier; name: string; compact?: boolean },
) {
  const recalledCount = [
    ...d.affiliations, ...d.history, ...d.capabilities,
  ].filter((c) => c.basis === 'recalled').length;

  return (
    <div>
      <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>{d.summary}</p>

      {d.affiliations.length > 0 && (
        <div className="formfield">
          <span className="fnum">A.</span>
          <div className="fbody">
            <span className="flabel">Affiliations</span>
            {d.affiliations.map((a, i) => (
              <p className="assess" key={i} style={{ marginBottom: 7 }}>
                <b>{a.organisation}</b>
                {a.role} &mdash; {a.period} <Basis basis={a.basis} confidence={a.confidence} />
              </p>
            ))}
          </div>
        </div>
      )}

      {d.history.length > 0 && (
        <div className="formfield">
          <span className="fnum">B.</span>
          <div className="fbody">
            <span className="flabel">Prior episodes</span>
            {d.history.map((h, i) => (
              <p className="assess" key={i} style={{ marginBottom: 9 }}>
                <b>{h.when}</b>
                {h.what}
                <br />
                <span style={{ color: 'var(--toner-3)' }}>changes how a new event reads: {h.whyItMatters}</span>
                {' '}<Basis basis={h.basis} confidence={h.confidence} />
              </p>
            ))}
          </div>
        </div>
      )}

      {/* The possibility axis. Highlighted because it is the field that turns a
          denial into a checkable question rather than a dead end. */}
      {d.capabilities.length > 0 && (
        <div className="formfield">
          <span className="fnum">C.</span>
          <div className="fbody">
            <span className="flabel">Positioned to &mdash; capability, not conduct</span>
            {d.capabilities.map((c, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <p className="hilite" style={{ marginBottom: 5 }}>
                  <span>{c.capability}</span>
                </p>
                <p className="assess" style={{ marginBottom: 3 }}>
                  <b>Would take</b>{c.whatItWouldTake}
                </p>
                <p className="assess" style={{ marginBottom: 3 }}>
                  <b>Trace if they were pursuing it</b>{c.observableIfReal}
                </p>
                <Basis basis={c.basis} confidence={c.confidence} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!compact && d.watchPoints.length > 0 && (
        <div className="formfield">
          <span className="fnum">D.</span>
          <div className="fbody">
            <span className="flabel">Watch for</span>
            {d.watchPoints.map((w, i) => (
              <p className="assess" key={i} style={{ marginBottom: 7 }}>
                <b>{w.watchFor}</b>{w.whyItWouldMatter}
              </p>
            ))}
          </div>
        </div>
      )}

      <p
        className="instruction"
        style={{ marginTop: 14, marginBottom: 0, borderBottom: 'none', paddingBottom: 0 }}
      >
        Dossier on {name} written {d.builtAt.slice(0, 10)}
        {d.model ? ` by ${d.model}` : ''} against {d.corpusEvents} event
        {d.corpusEvents === 1 ? '' : 's'} on file.
        {recalledCount > 0 && (
          <>
            {' '}<b>{recalledCount} claim{recalledCount === 1 ? '' : 's'} marked unverified</b> &mdash;
            asserted from model training rather than from a record here. Plausible, possibly
            out of date, and not evidence of anything.
          </>
        )}
      </p>
    </div>
  );
}
