'use client';

import { useState } from 'react';
import Constellation, { type ConstellationNode } from './constellation';

/**
 * The map panel: fire the network, then optionally ask for a judgement.
 *
 * Two buttons rather than one, because the two operations differ in kind. Firing
 * is deterministic, free and repeatable, and it shows the structure of the
 * corpus around this story. Judging costs a model call and returns an opinion.
 * Collapsing them would mean a person could not look at the map without paying
 * for a verdict about it.
 */
interface Lead {
  party: string;
  mechanism: string;
  whatWouldConfirm: string;
  falsifier: string;
  confidence: number;
}

interface Result {
  judged: boolean;
  seedNames: string[];
  nodes: ConstellationNode[];
  distant: number;
  hubsHeld: string[];
  leads: Lead[];
  dismissed: string;
  skipped: string | null;
}

export default function Network({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'firing' | 'judging' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [sel, setSel] = useState<ConstellationNode | null>(null);

  async function run(judge: boolean) {
    setState(judge ? 'judging' : 'firing');
    setMsg('');
    try {
      const r = await fetch(`/api/synthesize/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ judge, rebuild: !judge }),
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

  const busy = state === 'firing' || state === 'judging';

  return (
    <div>
      <div className="filters" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => run(false)} disabled={busy}>
          {state === 'firing' ? 'Firing…' : 'Fire the network'}
        </button>
        <button className="btn btn-go" onClick={() => run(true)} disabled={busy}>
          {state === 'judging' ? 'Reading the chains…' : 'Fire and judge (model call)'}
        </button>
      </div>

      {state === 'error' && (
        <p className="assess"><b style={{ color: 'var(--stamp)' }}>Could not run</b>{msg}</p>
      )}

      {state === 'done' && res && (
        <>
          {res.skipped ? (
            <p className="assess"><b>Result</b>{res.skipped}</p>
          ) : (
            <>
              <p className="assess" style={{ marginBottom: 12 }}>
                <b>Fired</b>
                {res.nodes.length} parties reached from {res.seedNames.length} in this story
                {'; '}{res.distant} of them only through an intermediary.
                {res.hubsHeld.length > 0 && (
                  <> Held at hubs, which receive but do not relay: {res.hubsHeld.slice(0, 6).join(', ')}.</>
                )}
              </p>

              {res.nodes.length > 0 && (
                <Constellation seedNames={res.seedNames} nodes={res.nodes} onSelect={setSel} />
              )}

              {sel && (
                <p className="hilite" style={{ marginTop: 12 }}>
                  <b>Selected chain</b>
                  <span>{sel.pathNames.join(' → ')}</span>
                </p>
              )}

              {res.judged && (
                <div style={{ marginTop: 18 }}>
                  {res.leads.length === 0 ? (
                    <p className="assess">
                      <b>No leads</b>
                      Every chain reviewed was coincidence. That is the common and correct outcome:
                      most paths through a co-occurrence graph join parties that have nothing to do
                      with each other.
                    </p>
                  ) : (
                    res.leads.map((l, i) => (
                      <div className="formfield" key={i}>
                        <span className="fnum">{60 + i}.</span>
                        <div className="fbody">
                          <span className="flabel">
                            Lead &mdash; {l.party} &mdash; confidence {l.confidence.toFixed(2)}
                          </span>
                          <p className="hilite"><span>{l.mechanism}</span></p>
                          <p className="assess"><b>Confirm by</b>{l.whatWouldConfirm}</p>
                          <p className="assess"><b>Would falsify</b>{l.falsifier}</p>
                        </div>
                      </div>
                    ))
                  )}
                  {res.dismissed && (
                    <p className="assess" style={{ marginTop: 10 }}>
                      <b>What was dismissed</b>{res.dismissed}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
