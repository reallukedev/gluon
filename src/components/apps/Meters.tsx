"use client";
import * as React from "react";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Sparkline } from "@/components/charts/TimeChart";
import s from "./meters.module.css";

export interface AppUsage {
  cpu: number;
  mem: number;
  /** CPU (% of the machine) for each recent sample, oldest first. */
  cpuSeries: number[];
}

const SERIES = 40;

/** Live CPU and memory per app, summed over its containers, with a short CPU history. */
export function useAppUsage(apps: { id: string; containers: { name: string }[] }[]): Map<string, AppUsage> {
  const { containers } = useLive();
  return React.useMemo(() => {
    const out = new Map<string, AppUsage>();
    const recent = containers.slice(-SERIES).map((c) => new Map(c.list.map((x) => [x.name, x])));
    const last = recent.at(-1);
    if (!last) return out;
    for (const a of apps) {
      if (!a.containers.some((c) => last.has(c.name))) continue;
      let cpu = 0;
      let mem = 0;
      for (const c of a.containers) {
        const st = last.get(c.name);
        if (st) {
          cpu += st.cpu;
          mem += st.mem;
        }
      }
      const cpuSeries = recent.map((m) => a.containers.reduce((n, c) => n + (m.get(c.name)?.cpu ?? 0), 0));
      out.set(a.id, { cpu, mem, cpuSeries });
    }
    return out;
  }, [apps, containers]);
}

/**
 * A short CPU trace ending at now, then the figure. Idle apps draw a flat line on the floor.
 * `fit`: lay out by the surrounding container's width (the Apps table) instead of the window's.
 */
export function CpuMeter({ series, value, name, fit }: { series: number[] | null; value: number | null; name: string; fit?: boolean }) {
  const fmt = useFormat();
  if (value === null)
    return (
      <span className={s.none} data-fit={fit ? "" : undefined}>
        No reading
      </span>
    );
  const peak = Math.max(...(series ?? [value]));
  return (
    <span className={s.meter} data-fit={fit ? "" : undefined}>
      <span className={s.name} aria-hidden>
        CPU
      </span>
      <span className={s.spark} aria-hidden>
        {series && series.length > 1 && <Sparkline points={series} height={16} yMax={Math.max(5, peak * 1.15)} tone={value >= 1 ? "ink" : "muted"} />}
      </span>
      <span className={`${s.value} num`} aria-label={`${name} CPU ${fmt.percent(value, 1)}`}>
        {fmt.percent(value, 1)}
      </span>
    </span>
  );
}

/**
 * Memory as a bar measured against the app using the most (so rows compare at a glance), then the
 * figure. The tooltip gives the share of the whole machine.
 */
export function MemMeter({ value, scale, total, name, fit }: { value: number | null; scale: number; total: number | null; name: string; fit?: boolean }) {
  const fmt = useFormat();
  if (value === null)
    return (
      <span className={s.none} data-fit={fit ? "" : undefined}>
        No reading
      </span>
    );
  const share = scale > 0 ? Math.min(1, value / scale) : 0;
  return (
    <span className={s.meter} data-fit={fit ? "" : undefined} title={total ? `${fmt.percent((value / total) * 100, 1)} of this server's ${fmt.bytes(total, 0)}` : undefined}>
      <span className={s.name} aria-hidden>
        Memory
      </span>
      <span className={s.bar} aria-hidden>
        <span style={{ transform: `scaleX(${Math.max(share, 0.015)})` }} />
      </span>
      <span className={`${s.value} num`} aria-label={`${name} memory ${fmt.bytes(value)}`}>
        {fmt.bytes(value)}
      </span>
    </span>
  );
}
