import "server-only";
import { filesystems, history, sampleFilesystems } from "../metrics/sampler";
import type { SpaceData, SpaceDisk } from "@/lib/home-widgets-types";

/**
 * "Running out of space": for each real filesystem, the trend of used bytes over the last week, from the history the
 * metrics sampler already keeps (`fs.<mount>.used`, a minute value, rolled up hourly). The slope is Theil–Sen (the
 * median of pairwise slopes), so one big download or clean-up doesn't swing the forecast the way a straight-line fit
 * would.
 */

const WINDOW_MS = 7 * 86_400_000;
const MIN_HOURS = 12;
const MIN_SIZE = 512 * 1024 * 1024;

function theilSen(points: [number, number][]): number {
  // Keep it bounded: at most ~200 points (hourly for a week is ~170).
  const step = Math.max(1, Math.ceil(points.length / 200));
  const p = points.filter((_, i) => i % step === 0);
  const slopes: number[] = [];
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const dt = p[j]![0] - p[i]![0];
      if (dt > 0) slopes.push((p[j]![1] - p[i]![1]) / dt);
    }
  }
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)]!;
}

/** Growth under this per day is normal churn (logs, caches), not a trend: 0.05% of the disk, at least 100 MB. */
const noise = (size: number) => Math.max(100 * 1024 * 1024, size * 0.0005);

export function spaceData(): SpaceData {
  const list = (filesystems().length ? filesystems() : sampleFilesystems()).filter((f) => f.size >= MIN_SIZE);
  const series = history(
    list.map((f) => `fs.${f.mount}.used`),
    WINDOW_MS,
  );
  const disks: SpaceDisk[] = list.map((f) => {
    const pts = (series[`fs.${f.mount}.used`] ?? []).filter(([, v]) => Number.isFinite(v));
    // Make sure "now" is in the fit even if the last stored minute is a little old.
    if (pts.length && pts.at(-1)![0] < Date.now() - 5 * 60_000) pts.push([Date.now(), f.used]);
    const hours = pts.length > 1 ? (pts.at(-1)![0] - pts[0]![0]) / 3_600_000 : 0;
    const base = { mount: f.mount, size: f.size, used: f.used, avail: f.avail, pct: f.pct, historyHours: Math.round(hours) };
    if (hours < MIN_HOURS || pts.length < 12) return { ...base, perDay: null, daysToFull: null, trend: "learning" as const };
    const perDay = theilSen(pts) * 86_400_000;
    const n = noise(f.size);
    if (perDay > n) return { ...base, perDay, daysToFull: f.avail / perDay, trend: "filling" as const };
    if (perDay < -n) return { ...base, perDay, daysToFull: null, trend: "shrinking" as const };
    return { ...base, perDay, daysToFull: null, trend: "steady" as const };
  });
  // Soonest to fill first, then the fullest.
  disks.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity) || b.pct - a.pct);
  return { disks, checkedAt: Date.now() };
}
