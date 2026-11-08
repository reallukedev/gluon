/**
 * Path building for the hairline charts, kept apart from React so it can be tested. A sample with no
 * value (NaN, null from a failed read) is a gap in the line, never a drop to zero: unknown is not 0.
 */

export type Point = [number, number];

export interface SeriesPath {
  /** The line, broken at gaps. */
  d: string;
  /** The area under it, one closed shape per run. Empty unless asked for. */
  area: string;
  /** Points with a real value inside the window, for hover and the end dot. */
  pts: Point[];
  /** Points that sit alone between gaps, drawn as dots so they don't vanish. */
  lonely: Point[];
}

const ok = (p: Point) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function seriesPath(points: Point[], o: { tMin: number; tMax: number; x: (t: number) => number; y: (v: number) => number; floor: number; area?: boolean }): SeriesPath {
  const { tMin, tMax, x, y, floor } = o;
  const inWindow = points.filter((p) => Number.isFinite(p[0]) && p[0] >= tMin - (tMax - tMin) * 0.02 && p[0] <= tMax + 1);
  const pts = inWindow.filter(ok);
  // Break the line where samples are missing (> 3× median spacing) instead of drawing across them.
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i]![0] - pts[i - 1]![0]);
  const med = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 0;
  // A sample with no value also breaks the line at the next real one.
  const brokenAfter = new Set<number>();
  for (let i = 0, last = -1; i < inWindow.length; i++) {
    if (ok(inWindow[i]!)) last = inWindow[i]![0];
    else if (last >= 0) brokenAfter.add(last);
  }
  let d = "";
  let area = "";
  const lonely: Point[] = [];
  let segStart: number | null = null;
  let segLen = 0;
  const close = (prev: Point) => {
    if (segStart === null) return;
    if (segLen === 1) lonely.push(prev);
    if (o.area) area += `L${x(prev[0]).toFixed(1)},${floor}L${segStart.toFixed(1)},${floor}Z`;
  };
  pts.forEach((p, i) => {
    const prev = pts[i - 1];
    const gap = !!prev && ((med > 0 && p[0] - prev[0] > med * 3) || brokenAfter.has(prev[0]));
    const px = x(p[0]).toFixed(1);
    const py = y(p[1]).toFixed(1);
    if (i === 0 || gap) {
      if (prev) close(prev);
      d += `M${px},${py}`;
      segStart = x(p[0]);
      segLen = 1;
      if (o.area) area += `M${px},${floor}L${px},${py}`;
    } else {
      d += `L${px},${py}`;
      segLen++;
      if (o.area) area += `L${px},${py}`;
    }
  });
  if (pts.length) close(pts.at(-1)!);
  return { d, area, pts, lonely };
}

/** A sparkline's path in a 0..100 wide box; missing values break the line. */
export function sparkPath(values: number[], height: number, yMax?: number): string {
  const vals = values.length === 1 ? [values[0]!, values[0]!] : values;
  const n = vals.length;
  const finite = vals.filter(Number.isFinite);
  const max = yMax && yMax > 0 ? yMax : Math.max(1e-9, ...finite) * 1.1;
  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    const px = ((i / Math.max(1, n - 1)) * 100).toFixed(2);
    const py = (height - (Math.min(Math.max(v, 0), max) / max) * (height - 3) - 1.5).toFixed(2);
    d += `${pen ? "L" : "M"}${px},${py}`;
    pen = true;
  });
  return d;
}

/** A round axis top a little above the data; 1 when there is nothing to scale. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
