'use client';

import { useState } from 'react';

/**
 * The button.
 *
 * It is a POST and it is explicit, because it spends money: extraction if the
 * item has not been extracted, and a model call if hypotheses are asked for.
 * A page render must never do that on its own.
 */
type Result = {
  events: number;
  related: Array<{ occurredAt: string; type: string; summary: string }>;
  relatedItems: Array<{ id: string; title: string; publishedAt: string }>;
  connections: Array<{ kind: string; basis: string; confidence: number; explanation: string; falsifier: string | null }>;
};

export default function InvestigateButton({ id, hasEvents }: { id: string; hasEvents: boolean }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [hypotheses, setHypotheses] = useState(false);

  async function run() {
    setState('running');
    setMsg('');
    try {
      const r = await fetch(`/api/investigate/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hypotheses }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
      setRes(body);
      setState('done');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  return (
    <div>
      <div className="filters" style={{ marginBottom: 14 }}>
        <button className="btn btn-go" onClick={run} disabled={state === 'running'}>
          {state === 'running' ? 'Working…' : hasEvents ? 'Investigate' : 'Extract & investigate'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.76rem', textTransform: 'uppercase', letterSpacing: '.1em' }}>
          <input type="checkbox" checked={hypotheses} onChange={(e) => setHypotheses(e.target.checked)} />
          Also propose hypotheses (model call)
        </label>
      </div>

      {state === 'error' ? (
        <div className="field" style={{ borderLeftColor: 'var(--stamp)' }}>
          <b style={{ color: 'var(--stamp)' }}>Could not run</b>{msg}
        </div>
      ) : null}

      {state === 'done' && res ? (
        <div>
          <p className="note" style={{ marginBottom: 12 }}>
            {res.events} event{res.events === 1 ? '' : 's'} in this item &middot;{' '}
            {res.related.length} elsewhere in the corpus sharing a party &middot;{' '}
            {res.relatedItems.length} unextracted items mentioning them
          </p>

          {res.connections.length === 0 ? (
            <div className="field assess">
              <b>Result</b>
              Nothing joined. No other event in the corpus shares a party with this one inside the
              window. That is the common result and it is a real answer, not a failure to run.
            </div>
          ) : (
            res.connections.map((c, i) => (
              <div className="field" key={i}>
                <b>{c.basis} &middot; {c.kind} &middot; {c.confidence.toFixed(2)}</b>
                {c.explanation}
                {c.falsifier ? <div style={{ marginTop: 6, color: 'var(--carbon-3)' }}>Would falsify: {c.falsifier}</div> : null}
              </div>
            ))
          )}

          {res.relatedItems.length > 0 ? (
            <>
              <h4 style={{ textTransform: 'uppercase', letterSpacing: '.1em', fontSize: '0.76rem', margin: '18px 0 8px' }}>
                Also on file
              </h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {res.relatedItems.slice(0, 12).map((it) => (
                  <li key={it.id} style={{ marginBottom: 5 }}>
                    <span className="refno">{it.publishedAt.slice(0, 10)}</span>{' '}
                    <a href={`/item/${it.id}`}>{it.title}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
