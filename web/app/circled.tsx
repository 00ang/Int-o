/**
 * The ellipse a reviewer draws around a phrase they are flagging.
 *
 * In the released scans this is what marks the passage under consideration -
 * drawn by hand, in one pass, overshooting at the join. It sits behind the
 * text rather than around a box, so it reads as annotation on a page rather
 * than as a UI element.
 */
export default function Circled({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <svg
        aria-hidden="true"
        viewBox="0 0 200 44"
        preserveAspectRatio="none"
        style={{
          position: 'absolute', inset: '-7px -10px', width: 'calc(100% + 20px)',
          height: 'calc(100% + 14px)', pointerEvents: 'none', overflow: 'visible',
        }}
      >
        <path
          d="M104 3 C158 2 196 10 197 22 C198 34 152 41 98 42 C44 43 4 35 3 23 C2 11 46 4 100 3 C120 3 136 4 150 6"
          fill="none" stroke="#C4241A" strokeWidth="1.6" strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span style={{ position: 'relative' }}>{children}</span>
    </span>
  );
}
