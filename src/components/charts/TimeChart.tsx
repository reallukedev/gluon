"use client";
import * as React from "react";
import s from "./charts.module.css";

export interface Series {
  key: string;
  label: string;
  points: [number, number][];
  tone?: "ink" | "muted" | "attn" | "fault";
  /** Draw an area fill under this series (first series only looks best). */
  area?: boolean;
}

interface Props {
  series: Series[];
  height?: number;
  /** Fixed y-axis max; otherwise a rounded-up max of the data. */
  yMax?: number;
  format: (v: number) => string;
  formatTime: (t: number) => string;
  /** Visible time window in ms ending at `now` (live charts) or the data's end. */
  windowMs?: number;
  live?: boolean;
  label: string;
  /** Compact: no axis labels (for cards). */
  compact?: boolean;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** A live chart's right edge: the newest sample while the stream is fresh, else the wall clock. */
function liveEdge(latest: number): number {
  const now = Date.now();
  return latest > 0 && now - latest < 15_000 ? Math.max(latest, now - 15_000) : now;
}

/**
 * A time series chart drawn in hairlines. Rules and the "now" line snap to device pixels at any
 * DPR (crispEdges); data lines stay antialiased. Hovering (or touching) pins a readout and freezes
 * the picture — data and time window — so live data doesn't slide out from under the pointer.
 * Live charts step with their samples (the right edge is the newest sample), never by render
 * timing, so streaming data doesn't jitter. Values are never animated.
 */
export function TimeChart({ series, height = 140, yMax, format, formatTime, windowMs, live, label, compact }: Props) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [hover, setHover] = React.useState<number | null>(null);
  const [frozen, setFrozen] = React.useState<{ series: Series[]; tMax: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const data = frozen?.series ?? series;
  let dataMax = 0;
  let dataMin = Infinity;
  let vPeak = 0;
  let count = 0;
  for (const sr of data)
    for (const p of sr.points) {
      if (p[0] > dataMax) dataMax = p[0];
      if (p[0] < dataMin) dataMin = p[0];
      if (p[1] > vPeak) vPeak = p[1];
      count++;
    }
  const liveMax = live ? liveEdge(dataMax) : 0;
  const tMax = frozen?.tMax ?? (live ? liveMax : dataMax || Date.now());
  const tMin = windowMs ? tMax - windowMs : Math.min(dataMin, tMax);
  const vMax = yMax ?? niceMax(vPeak * 1.1);
  const padR = compact ? 0 : 44;
  const padB = compact ? 0 : 20;
  const plotW = Math.max(10, width - padR);
  const plotH = height - padB;
  const x = (t: number) => ((t - tMin) / Math.max(1, tMax - tMin)) * plotW;
  const y = (v: number) => plotH - (Math.min(Math.max(v, 0), vMax) / vMax) * (plotH - 6) - 1;

  const paths = data.map((sr) => {
    const pts = sr.points.filter((p) => p[0] >= tMin - (tMax - tMin) * 0.02 && p[0] <= tMax + 1);
    // Break the line where there are gaps (> 3× median spacing) instead of drawing across them.
    const gaps: number[] = [];
    for (let i = 1; i < pts.length; i++) gaps.push(pts[i]![0] - pts[i - 1]![0]);
    const med = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 0;
    let d = "";
    let area = "";
    const lonely: [number, number][] = [];
    let segStart: number | null = null;
    let segLen = 0;
    pts.forEach((p, i) => {
      const gap = i > 0 && med > 0 && p[0] - pts[i - 1]![0] > med * 3;
      const px = x(p[0]).toFixed(1);
      const py = y(p[1]).toFixed(1);
      if (i === 0 || gap) {
        if (segStart !== null) {
          if (segLen === 1) lonely.push(pts[i - 1]!);
          if (sr.area) area += `L${x(pts[i - 1]![0]).toFixed(1)},${plotH}L${segStart.toFixed(1)},${plotH}Z`;
        }
        d += `M${px},${py}`;
        segStart = x(p[0]);
        segLen = 1;
        if (sr.area) area += `M${px},${plotH}L${px},${py}`;
      } else {
        d += `L${px},${py}`;
        segLen++;
        if (sr.area) area += `L${px},${py}`;
      }
    });
    if (pts.length && segStart !== null) {
      if (segLen === 1) lonely.push(pts.at(-1)!);
      if (sr.area) area += `L${x(pts.at(-1)![0]).toFixed(1)},${plotH}L${(segStart as number).toFixed(1)},${plotH}Z`;
    }
    return { sr, d, area, pts, lonely };
  });

  // Hover → nearest timestamp across the first series.
  const base = paths[0]?.pts ?? [];
  const hoverIdx = hover === null || !base.length ? null : base.reduce((best, p, i) => (Math.abs(x(p[0]) - hover) < Math.abs(x(base[best]![0]) - hover) ? i : best), 0);
  const hoverT = hoverIdx !== null ? base[hoverIdx]![0] : null;
  const nearest = (pts: [number, number][], t: number) => pts.reduce((b, q) => (Math.abs(q[0] - t) < Math.abs(b[0] - t) ? q : b), pts[0] ?? [t, 0]);

  const track = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const px = clientX - r.left;
    if (px < 0 || px > plotW) return setHover(null);
    if (!frozen && live) setFrozen({ series, tMax });
    setHover(px);
  };
  const onLeave = () => {
    setHover(null);
    setFrozen(null);
  };

  const last = data.map((sr) => sr.points.at(-1)?.[1]);
  const peak = Math.max(0, ...(data[0]?.points.map((p) => p[1]) ?? [0]));
  const empty = count === 0;
  const aria = empty ? `${label}. No data yet.` : `${label}. Now ${last[0] !== undefined ? format(last[0]) : "no data"}, peak ${format(peak)}.`;
  const flip = hover !== null && hover > plotW / 2;

  return (
    <div
      className={s.chart}
      ref={wrap}
      style={{ height }}
      onPointerMove={(e) => track(e.clientX)}
      onPointerDown={(e) => track(e.clientX)}
      onPointerLeave={onLeave}
      onPointerCancel={onLeave}
      role="img"
      aria-label={aria}
    >
      {width > 0 && (
        <svg width={width} height={height} className={s.svg} aria-hidden>
          {!compact &&
            !empty &&
            [0.5, 1].map((f) => (
              <g key={f}>
                <line x1={0} x2={plotW} y1={Math.round(y(vMax * f)) + 0.5} y2={Math.round(y(vMax * f)) + 0.5} className={s.grid} />
                <text x={plotW + 8} y={y(vMax * f) + 4} className={s.axis}>
                  {format(vMax * f)}
                </text>
              </g>
            ))}
          <line x1={0} x2={plotW} y1={plotH - 0.5} y2={plotH - 0.5} className={s.baseline} />
          {paths.map(({ sr, d, area, lonely }) => (
            <g key={sr.key} data-tone={sr.tone ?? "ink"} className={s.series}>
              {sr.area && <path d={area} className={s.area} />}
              <path d={d} className={s.line} />
              {lonely.map((p) => (
                <circle key={p[0]} cx={x(p[0])} cy={y(p[1])} r={1.75} className={s.lonely} />
              ))}
            </g>
          ))}
          {live && <line x1={plotW - 0.5} x2={plotW - 0.5} y1={0} y2={plotH} className={s.now} />}
          {hoverT !== null && (
            <>
              <line x1={Math.round(x(hoverT)) + 0.5} x2={Math.round(x(hoverT)) + 0.5} y1={0} y2={plotH} className={s.cursor} />
              {paths.map(({ sr, pts }) => {
                if (!pts.length) return null;
                const p = nearest(pts, hoverT);
                return <circle key={sr.key} cx={x(p[0])} cy={y(p[1])} r={3} className={s.dot} data-tone={sr.tone ?? "ink"} />;
              })}
            </>
          )}
          {!compact && !empty && (
            <>
              <text x={0} y={height - 5} className={s.axis}>
                {formatTime(tMin)}
              </text>
              <text x={plotW} y={height - 5} className={s.axis} textAnchor="end">
                {live ? "now" : formatTime(tMax)}
              </text>
            </>
          )}
        </svg>
      )}
      {empty && width > 0 && !compact && (
        <span className={s.empty} style={{ bottom: padB }}>
          No data yet
        </span>
      )}
      {hoverT !== null && (
        <div className={s.readout} data-flip={flip ? "" : undefined} style={{ left: hover ?? 0 }}>
          <span className={s.readoutTime}>{formatTime(hoverT)}</span>
          {paths.map(({ sr, pts }) => {
            if (!pts.length) return null;
            const p = nearest(pts, hoverT);
            return (
              <span key={sr.key} className={s.readoutRow}>
                <i data-tone={sr.tone ?? "ink"} />
                {data.length > 1 && <span className={s.readoutLabel}>{sr.label}</span>}
                <b className="num">{format(p[1])}</b>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Minimal inline trend: a line ending at a marked "now". */
export function Sparkline({ points, height = 28, yMax, tone = "muted", label }: { points: number[]; height?: number; yMax?: number; tone?: Series["tone"]; label?: string }) {
  const pts = points.length === 1 ? [points[0]!, points[0]!] : points;
  const n = pts.length;
  const max = yMax ?? Math.max(1e-9, ...pts) * 1.1;
  const d = pts
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / Math.max(1, n - 1)) * 100).toFixed(2)},${(height - (Math.min(Math.max(v, 0), max) / max) * (height - 3) - 1.5).toFixed(2)}`)
    .join("");
  return (
    <svg className={s.spark} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-tone={tone}>
      {n > 0 && <path d={d} vectorEffect="non-scaling-stroke" />}
      <line x1="100" x2="100" y1="0" y2={height} vectorEffect="non-scaling-stroke" className={s.sparkNow} />
    </svg>
  );
}
