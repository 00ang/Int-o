'use client';

import { useEffect, useState } from 'react';
import Chart, { type GraphEdge, type GraphNode } from './chart';
import Relations from './relations';

/**
 * Loads the map, and offers a rebuild.
 *
 * The chart is read on mount because looking at the map costs nothing. The
 * rebuild is a button because recomputing every edge is work, and a page that
 * silently does work on load is a page you learn not to refresh.
 */
export default function MapPanel() {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'rebuilding' | 'error'>('loading');
  const [picked, setPicked] = useState<GraphNode | null>(null);
  const [msg, setMsg] = useState('');

  async function load(rebuild: boolean) {
    setState(rebuild ? 'rebuilding' : 'loading');
    setMsg('');
    try {
      const r = await fetch('/api/graph', { method: rebuild ? 'POST' : 'GET' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
      setData({ nodes: body.nodes, edges: body.edges });
      setState('ready');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  useEffect(() => { void load(false); }, []);

  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => load(true)} disabled={state === 'rebuilding'}>
          {state === 'rebuilding' ? 'Rewiring…' : 'Rebuild from current events'}
        </button>
      </div>
      {state === 'error' && (
        <p className="assess"><b style={{ color: 'var(--stamp)' }}>Could not load the map</b>{msg}</p>
      )}
      {state === 'loading' && <p className="empty">Reading the map…</p>}
      {data && data.nodes.length === 0 && (
        <p className="empty">No links yet. Extract some items, then rebuild.</p>
      )}
      {data && data.nodes.length > 0 && (
        <>
          <Chart nodes={data.nodes} edges={data.edges} onPick={setPicked} />
          <Relations party={picked} />
        </>
      )}
    </div>
  );
}
