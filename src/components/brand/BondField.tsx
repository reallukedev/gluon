import type * as React from "react";

/**
 * The sign-in plate's drawing: the server as a row of state lines (the same vocabulary as the Status
 * spectrum) held together by gluon coils, like a ladder diagram in a physics notebook. The pattern is
 * fixed, so it says nothing about the server before anyone signs in.
 */

const W = 460;
const H = 340;
const LINES = 14;
const GAP = W / (LINES - 1);

// Per line: its state form. Per rung: which gap (left line index) and how far down it sits (0–1).
const FORMS = ["", "", "dash", "", "", "", "short", "", "", "", "", "dash", "", ""] as const;
const RUNGS: [number, number][] = [
  [0, 0.18], [1, 0.62], [2, 0.34], [3, 0.8], [4, 0.12], [4, 0.52], [5, 0.78], [6, 0.7],
  [7, 0.2], [8, 0.46], [9, 0.86], [10, 0.28], [11, 0.64], [12, 0.4],
];

function coil(x0: number, x1: number, yc: number, loops: number, a: number): string {
  const steps = 22;
  const c = (x1 - x0) / (2 * Math.PI * loops);
  let d = "";
  for (let i = 0; i <= loops * steps; i++) {
    const t = Math.PI + (i / (loops * steps)) * 2 * Math.PI * loops;
    const x = x0 + c * (t - Math.PI) - a * Math.sin(t);
    const y = yc - a * Math.cos(t);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

export function BondField({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox={`-6 -6 ${W + 12} ${H + 12}`} fill="none" aria-hidden preserveAspectRatio="xMidYMid meet">
      {FORMS.map((form, i) => {
        const x = i * GAP;
        const top = form === "short" ? H * 0.62 : 0;
        return (
          <path
            key={`l${i}`}
            data-part="line"
            d={`M${x.toFixed(1)} ${top}V${H}`}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={form === "dash" ? "5 5" : undefined}
            style={{ "--i": i } as React.CSSProperties}
          />
        );
      })}
      {RUNGS.map(([gap, at], i) => {
        const y = at * H;
        // A rung never lands on the short line's missing top.
        const x0 = gap * GAP + 3.5;
        const x1 = (gap + 1) * GAP - 3.5;
        return (
          <g key={`r${i}`} data-part="rung" style={{ "--i": i } as React.CSSProperties}>
            <path d={coil(x0, x1, y - 6.6, 2, 6.2)} pathLength={1} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={x0 - 3.5} cy={y - 0.4} r="2.6" fill="currentColor" />
            <circle cx={x1 + 3.5} cy={y - 0.4} r="2.6" fill="currentColor" />
          </g>
        );
      })}
    </svg>
  );
}
