'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The fired region, drawn as a chart.
 *
 * Not a force-directed hairball. The layout is radial by hop count, because
 * hops are the one thing here that carries meaning: the seed sits at the
 * centre, parties named alongside it ring the first orbit, and everything
 * further out was reached only through an intermediary. Reading distance from
 * the centre reads how indirect the association is, which is the whole
 * question.
 *
 * Energy sets the size of a mark, never its position. Position is structural
 * and stable between renders; brightness is the reading.
 */
export interface ConstellationNode {
  id: string;
  name: string;
  kind: string;
  energy: number;
  hops: number;
  path: string[];
  pathNames: string[];
}

interface Props {
  seedNames: string[];
  nodes: ConstellationNode[];
  onSelect?: (node: ConstellationNode | null) => void;
}

const INK = '#0B0B0A';
const STAMP = '#C4241A';
const HI = '#F5EC24';

export default function Constellation({ seedNames, nodes, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 760));
    ro.observe(el);
    setW(el.clientWidth || 760);
    return () => ro.disconnect();
  }, []);

  const h = Math.max(340, Math.min(560, w * 0.68));
  const cx = w / 2;
  const cy = h / 2;
  const maxHop = Math.max(1, ...nodes.map((n) => n.hops));
  const ringGap = (Math.min(w, h) / 2 - 46) / maxHop;

  const placed = useMemo(() => {
    const byHop = new Map<number, ConstellationNode[]>();
    for (const n of nodes) {
      const l = byHop.get(n.hops);
      if (l) l.push(n); else byHop.set(n.hops, [n]);
    }
    const out: Array<ConstellationNode & { x: number; y: number; r: number }> = [];
    const maxE = Math.max(...nodes.map((n) => n.energy), 0.0001);
    for (const [hop, group] of byHop) {
      // Sorting by name rather than energy keeps a party in the same place
      // between firings, so the chart stays legible as the corpus grows.
      const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
      sorted.forEach((n, i) => {
        // Offset each ring so marks do not line up into false spokes.
        const angle = (i / sorted.length) * Math.PI * 2 + hop * 0.7;
        const radius = 46 + ringGap * hop;
        out.push({
          ...n,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius * 0.82,
          r: 2.5 + Math.sqrt(n.energy / maxE) * 6.5,
        });
      });
    }
    return out;
  }, [nodes, cx, cy, ringGap]);

  const active = picked ?? hover;
  const activeNode = placed.find((p) => p.id === active) ?? null;
  const litPath = new Set(activeNode?.path ?? []);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={`Association chart: ${nodes.length} parties reached from ${seedNames.join(', ')}`}
        style={{ display: 'block', touchAction: 'manipulation' }}
      >
        {/* orbit rings, one per hop */}
        {Array.from({ length: maxHop }, (_, i) => i + 1).map((hop) => (
          <ellipse
            key={hop}
            cx={cx} cy={cy}
            rx={46 + ringGap * hop}
            ry={(46 + ringGap * hop) * 0.82}
            fill="none" stroke={INK} strokeWidth="0.5" strokeDasharray="2 5" opacity="0.35"
          />
        ))}

        {/* the route that lit the selected party */}
        {activeNode && activeNode.path.length > 1 && (
          <g>
            {activeNode.path.slice(0, -1).map((from, i) => {
              const to = activeNode.path[i + 1]!;
              const a = i === 0 ? { x: cx, y: cy } : placed.find((p) => p.id === from);
              const b = placed.find((p) => p.id === to);
              if (!a || !b) return null;
              return (
                <line
                  key={`${from}-${to}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={STAMP} strokeWidth="1.4"
                />
              );
            })}
          </g>
        )}

        {/* the seed */}
        <g>
          <circle cx={cx} cy={cy} r="7" fill={INK} />
          <circle cx={cx} cy={cy} r="12" fill="none" stroke={INK} strokeWidth="1" />
          <text
            x={cx} y={cy + 27} textAnchor="middle"
            fontSize="10" fontFamily="Courier Prime, monospace" fontWeight="700" fill={INK}
          >
            {seedNames[0] ?? 'seed'}
            {seedNames.length > 1 ? ` +${seedNames.length - 1}` : ''}
          </text>
        </g>

        {placed.map((n) => {
          const isActive = n.id === active;
          const onPath = litPath.has(n.id);
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                const next = picked === n.id ? null : n.id;
                setPicked(next);
                onSelect?.(next ? n : null);
              }}
              style={{ cursor: 'pointer' }}
            >
              {isActive && <circle cx={n.x} cy={n.y} r={n.r + 6} fill={HI} />}
              <circle
                cx={n.x} cy={n.y} r={n.r}
                fill={onPath && !isActive ? STAMP : INK}
                stroke={INK} strokeWidth="0.5"
              />
              {(isActive || n.r > 5) && (
                <text
                  x={n.x} y={n.y - n.r - 5} textAnchor="middle"
                  fontSize="9.5" fontFamily="Courier Prime, monospace"
                  fill={INK} style={{ paintOrder: 'stroke', stroke: '#F6F6F3', strokeWidth: 3 }}
                >
                  {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div
        style={{
          borderTop: `1px solid ${INK}`, marginTop: 6, paddingTop: 9,
          fontSize: '0.76rem', lineHeight: 1.5, minHeight: '3.4em',
        }}
      >
        {activeNode ? (
          <>
            <b style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {activeNode.name}
            </b>{' '}
            <span style={{ color: '#5E5E57' }}>
              [{activeNode.kind}, {activeNode.hops} hop{activeNode.hops === 1 ? '' : 's'}]
            </span>
            <br />
            <span style={{ color: '#5E5E57' }}>via </span>
            {activeNode.pathNames.join(' → ')}
          </>
        ) : (
          <span style={{ color: '#5E5E57' }}>
            Centre is this story. Each ring out is one degree of separation. Marks on the outer
            rings were never named beside it &mdash; hover or tap one to see the chain that
            reached it.
          </span>
        )}
      </div>
    </div>
  );
}
