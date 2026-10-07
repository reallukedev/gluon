// Collection drawings for the Home Assistant and Coolify widgets, in the same line language as ../previews.tsx
// (120×56 tile, words as 2px strokes, StateLine geometry, no fills beyond sunk).
import * as React from "react";
import p from "../../previews.module.css";

const W = ({ x, y, w, t = "line" }: { x: number; y: number; w: number; t?: "ink" | "ink2" | "faint" | "line" }) => (
  <line x1={x} x2={x + w} y1={y} y2={y} className={p.word} data-t={t} />
);

function Tile({ children }: { children: React.ReactNode }) {
  return (
    <svg className={p.preview} viewBox="0 0 120 56" width={120} height={56} aria-hidden focusable="false">
      <rect x={0.5} y={0.5} width={119} height={55} rx={6} className={p.tile} />
      {children}
    </svg>
  );
}

/** Home controls: pressable tiles, one lit. */
export function ControlsPreview() {
  const cells: [number, number, boolean][] = [
    [12, 8, true],
    [44, 8, false],
    [76, 8, false],
    [12, 30, false],
    [44, 30, true],
    [76, 30, false],
  ];
  return (
    <Tile>
      {cells.map(([x, y, on]) => (
        <g key={`${x}${y}`}>
          <rect x={x + 0.5} y={y + 0.5} width={29} height={18} rx={4} className={p.acc} data-on={on ? "" : undefined} />
          <circle cx={x + 7} cy={y + 7} r={2.5} className={p.accIcon} data-on={on ? "" : undefined} />
          <W x={x + 5} y={y + 14} w={14} t={on ? "ink2" : "faint"} />
        </g>
      ))}
    </Tile>
  );
}

/** Who's home: a solid line for home, a faint one for away, beside a round face. */
export function PeoplePreview() {
  return (
    <Tile>
      {[
        [13, true, 34],
        [29, true, 26],
        [45, false, 30],
      ].map(([y, home, w]) => (
        <g key={y as number}>
          <line x1={13} x2={13} y1={(y as number) - 5} y2={(y as number) + 5} className={p.glyph} data-s={home ? "running" : "stopped"} />
          <circle cx={26} cy={y as number} r={5} className={p.thumb} data-dim={home ? undefined : ""} />
          <W x={36} y={(y as number) - 2} w={w as number} t={home ? "ink" : "ink2"} />
          <W x={36} y={(y as number) + 3} w={(w as number) - 12} t="faint" />
        </g>
      ))}
    </Tile>
  );
}

/** Deployments: one dashed (deploying), one solid (worked), one short red (failed). */
export function DeploymentsPreview() {
  return (
    <Tile>
      {[
        [12, "starting", 44],
        [28, "running", 36],
        [44, "unhealthy", 40],
      ].map(([y, s, w]) => (
        <g key={y as number}>
          {s === "unhealthy" ? (
            <line x1={13} x2={13} y1={(y as number) + 0.5} y2={(y as number) + 5} className={p.fault} />
          ) : (
            <line x1={13} x2={13} y1={(y as number) - 5} y2={(y as number) + 5} className={p.glyph} data-s={s as string} />
          )}
          <W x={22} y={(y as number) - 2} w={w as number} t="ink2" />
          <W x={22} y={(y as number) + 3} w={(w as number) + 20} t="faint" />
        </g>
      ))}
    </Tile>
  );
}
