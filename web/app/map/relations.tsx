'use client';

import { useEffect, useState } from 'react';
import type { GraphNode } from './chart';

/**
 * Why a party is wired to each of its neighbours.
 *
 * The chart draws lines; a line asserts nothing on its own, because an edge
 * here records co-occurrence and not relationship. This is the part that makes
 * one worth reading: the actual events naming both parties, each linking back
 * to the record it came from, so a link can be walked and dismissed rather than
 * taken on faith.
 */
interface Evidence {
  summary: string; occurredAt: string; type: string;
  itemId: string; itemTitle: string; source: string;
}
interface Bio {
  summary: string;
  affiliations: Array<{ organisation: string; role: string; period: string; basis: string }>;
  capabilities: Array<{ capability: string }>;
}
interface Link {
  id: string; name: string; kind: string; slug: string;
  weight: number; eventCount: number; evidence: Evidence[];
}

export default function Relations({ party }: { party: GraphNode | null }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [bio, setBio] = useState<Bio | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!party) { setLinks(null); setState('idle'); return; }
    let live = true;
    setState('loading');
    fetch(`/api/party/${party.id}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
        if (!live) return;
        setLinks(body.links);
        setBio(body.bio ?? null);
        setState('ready');
      })
      .catch((e) => {
        if (!live) return;
        setMsg(e instanceof Error ? e.message : String(e));
        setState('error');
      });
    return () => { live = false; };
  }, [party]);

  if (!party) return null;

  return (
    <div style={{ marginTop: 20 }}>
      <div className="sheet-head">
        <span className="num">R.</span>
        <h2>{party.name}</h2>
        <span className="stamp stamp-hi">{party.degree} links</span>
      </div>
      <p className="instruction">
        What the corpus records between this party and each of its neighbours. An edge with no
        event listed was inferred from a shared document or storyline rather than from one record
        naming both &mdash; weaker, and said so.
      </p>
      {/* Who they are, before what they are wired to. A link between two names
          means little; a link between two known positions means more. */}
      {bio && (
        <div className="formfield" style={{ borderTop: '2px solid var(--rule)' }}>
          <span className="fnum">W.</span>
          <div className="fbody">
            <span className="flabel">Who they are</span>
            <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{bio.summary}</p>
            {bio.affiliations.slice(0, 4).map((a, i) => (
              <p className="assess" key={i} style={{ marginBottom: 4 }}>
                <b>{a.organisation}</b>{a.role} &mdash; {a.period}
                {a.basis === 'recalled' && (
                  <span style={{ color: 'var(--stamp)' }}> (unverified)</span>
                )}
              </p>
            ))}
            {bio.capabilities.length > 0 && (
              <p className="hilite" style={{ marginTop: 8 }}>
                <b>Positioned to</b>
                <span>{bio.capabilities.map((c) => c.capability).join('; ')}</span>
              </p>
            )}
          </div>
        </div>
      )}

      <p style={{ margin: '14px 0 16px' }}>
        <a href={`/entity/${encodeURIComponent(party.slug)}`}>
          Open {party.name}&rsquo;s full record &rarr;
        </a>
      </p>

      {state === 'loading' && <p className="empty">Reading the links&hellip;</p>}
      {state === 'error' && (
        <p className="assess"><b style={{ color: 'var(--stamp)' }}>Could not read them</b>{msg}</p>
      )}

      {state === 'ready' && links && links.length === 0 && (
        <p className="empty">No links on file for this party.</p>
      )}

      {state === 'ready' && links && links.map((l, i) => (
        <div className="formfield" key={l.id}>
          <span className="fnum">{String(i + 1).padStart(2, '0')}.</span>
          <div className="fbody">
            <span className="flabel">
              {l.kind} &middot; weight {l.weight.toFixed(2)}
              {l.eventCount > 0
                ? ` · ${l.eventCount} shared event${l.eventCount === 1 ? '' : 's'}`
                : ' · no shared event'}
            </span>
            <p style={{ margin: '0 0 8px', fontWeight: 700, textTransform: 'uppercase' }}>
              <a href={`/entity/${encodeURIComponent(l.slug)}`}>{l.name}</a>
            </p>
            {l.evidence.length === 0 ? (
              <p className="assess" style={{ margin: 0 }}>
                No single record names both. This link comes from appearing in the same document
                or storyline, which is the weakest kind the map records.
              </p>
            ) : (
              l.evidence.map((e, j) => (
                <p className="assess" key={j} style={{ marginBottom: 6 }}>
                  <b>{e.occurredAt.slice(0, 10)} &middot; {e.type} &middot; {e.source}</b>
                  {e.summary}{' '}
                  <a href={`/item/${e.itemId}`}>record &rarr;</a>
                </p>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
