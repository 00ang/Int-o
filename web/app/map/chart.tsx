'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The whole association map.
 *
 * Force-directed here, unlike the per-item chart, because there is no centre:
 * the question is what clusters the corpus has formed, and a radial layout
 * would impose an origin the data does not have. Simulated once on load and
 * then frozen, so the chart is a document rather than an aquarium - it can be
 * read, pointed at, and compared with the same chart tomorrow.
 *
 * Drawn to canvas rather than SVG: several hundred nodes with edges is more
 * DOM than a page should carry, and none of it needs to be individually
 * addressable.
 */
export interface GraphNode {
  id: string; name: string; kind: string; slug: string; degree: number;
}
export interface GraphEdge { a: string; b: string; w: number; n: number }

interface Placed extends GraphNode { x: number; y: number; vx: number; vy: number; r: number }

const INK = '#0B0B0A';
const STAMP = '#C4241A';
const HI = '#F5EC24';
const STOCK = '#F6F6F3';

/** Kinds get a mark, not a colour: this file is printed in one ink. */
const SHAPE: Record<string, 'dot' | 'square' | 'ring'> = {
  person: 'dot',
  company: 'square',
  organization: 'square',
  'government-body': 'ring',
  country: 'ring',
  location: 'ring',
};

export default function Chart({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<Placed | null>(null);
  const placedRef = useRef<Placed[]>([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 900));
    ro.observe(el);
    setW(el.clientWidth || 900);
    return () => ro.disconnect();
  }, []);

  const h = Math.max(420, Math.min(720, w * 0.7));

  const placed = useMemo(() => {
    if (nodes.length === 0) return [];
    const byId = new Map<string, Placed>();
    const maxDeg = Math.max(...nodes.map((n) => n.degree), 1);
    nodes.forEach((n, i) => {
      // Seeded on a spiral rather than at random, so the same corpus lays out
      // the same way twice and the chart is comparable with itself.
      const a = i * 2.399963;
      const rad = 12 * Math.sqrt(i);
      byId.set(n.id, {
        ...n,
        x: w / 2 + Math.cos(a) * rad,
        y: h / 2 + Math.sin(a) * rad,
        vx: 0, vy: 0,
        r: 2 + Math.sqrt(n.degree / maxDeg) * 7,
      });
    });

    const links = edges
      .map((e) => ({ s: byId.get(e.a), t: byId.get(e.b), w: e.w }))
      .filter((l): l is { s: Placed; t: Placed; w: number } => Boolean(l.s && l.t));

    // A short fixed simulation. Long enough to separate clusters, short enough
    // that the page is never busy for a noticeable moment.
    const arr = [...byId.values()];
    for (let step = 0; step < 260; step++) {
      const cool = 1 - step / 260;
      for (const n of arr) { n.vx *= 0.82; n.vy *= 0.82; }

      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]!;
        for (let j = i + 1; j < arr.length; j++) {
          const b = arr[j]!;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 90000) continue;
          const f = (900 * cool) / d2;
          const d = Math.sqrt(d2);
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
          b.vx += (dx / d) * f; b.vy += (dy / d) * f;
        }
      }
      for (const l of links) {
        const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 58) * 0.012 * Math.min(l.w, 3) * cool;
        l.s.vx += (dx / d) * f; l.s.vy += (dy / d) * f;
        l.t.vx -= (dx / d) * f; l.t.vy -= (dy / d) * f;
      }
      for (const n of arr) {
        n.vx += (w / 2 - n.x) * 0.0016;
        n.vy += (h / 2 - n.y) * 0.0016;
        n.x = Math.max(14, Math.min(w - 14, n.x + n.vx));
        n.y = Math.max(14, Math.min(h - 14, n.y + n.vy));
      }
    }
    placedRef.current = arr;
    return arr;
  }, [nodes, edges, w, h]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const byId = new Map(placed.map((p) => [p.id, p]));
    const near = hover
      ? new Set(edges.filter((e) => e.a === hover.id || e.b === hover.id)
          .flatMap((e) => [e.a, e.b]))
      : null;

    for (const e of edges) {
      const s = byId.get(e.a), t = byId.get(e.b);
      if (!s || !t) continue;
      const lit = hover && (e.a === hover.id || e.b === hover.id);
      ctx.strokeStyle = lit ? STAMP : INK;
      ctx.globalAlpha = lit ? 0.95 : 0.13;
      ctx.lineWidth = lit ? 1.4 : 0.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const n of placed) {
      const isHover = hover?.id === n.id;
      const isNear = near?.has(n.id) ?? false;
      if (isHover) {
        ctx.fillStyle = HI;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = INK;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      const shape = SHAPE[n.kind] ?? 'dot';
      if (shape === 'square') {
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      } else if (shape === 'ring') {
        ctx.fillStyle = STOCK;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      }
      // Label only what is big enough to matter, or what is being pointed at.
      if (isHover || isNear || n.r > 5.4) {
        ctx.font = `${isHover ? 700 : 400} 10px "Courier Prime", monospace`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = STOCK;
        const label = n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name;
        ctx.strokeText(label, n.x, n.y - n.r - 4);
        ctx.fillStyle = INK;
        ctx.fillText(label, n.x, n.y - n.r - 4);
      }
    }
  }, [placed, edges, hover, w, h]);

  function pick(ev: React.MouseEvent<HTMLCanvasElement>) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    let best: Placed | null = null, bestD = 18;
    for (const n of placedRef.current) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    setHover(best);
  }

  return (
    <div ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: h, display: 'block', cursor: 'crosshair' }}
        onMouseMove={pick}
        onMouseLeave={() => setHover(null)}
        aria-label={`Association map: ${nodes.length} parties, ${edges.length} links`}
      />
      <div
        style={{
          borderTop: `1px solid ${INK}`, marginTop: 6, paddingTop: 9,
          fontSize: '0.76rem', lineHeight: 1.5, minHeight: '3.2em',
        }}
      >
        {hover ? (
          <>
            <b style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>{hover.name}</b>{' '}
            <span style={{ color: '#5E5E57' }}>[{hover.kind}, {hover.degree} links]</span>
            <br />
            <a href={`/entity/${encodeURIComponent(hover.slug)}`}>Open this party&rsquo;s record &rarr;</a>
          </>
        ) : (
          <span style={{ color: '#5E5E57' }}>
            Every party the corpus has wired to another. Dot = person, square = company or
            organisation, ring = government body or place. Size is how many links a party
            carries. Point at one to light its associations.
          </span>
        )}
      </div>
    </div>
  );
}
