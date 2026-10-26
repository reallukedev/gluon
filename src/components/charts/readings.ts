"use client";
import * as React from "react";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import type { HostSample } from "@/server/metrics/sampler";

/**
 * Every live machine figure in the app comes from here, so Processor reads the same on Home,
 * Status and System. Each reading is the figure itself, one line of context in numbers, and the
 * series its chart draws. "Usually" is the median of the last 24 hours, and only appears once
 * there are a couple of hours to go on; until then the context gives the peak on the chart.
 */
export type ReadingKey = "cpu" | "mem" | "net" | "disk" | "temp";

export interface MachineReading {
  key: ReadingKey;
  label: string;
  /** The figure without its unit, e.g. "13" or "11.4". */
  value: string;
  unit: string;
  /** One short line of context, in numbers. */
  context: string;
  points: [number, number][];
  yMax?: number;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
}

export interface MachineReadings {
  readings: Partial<Record<ReadingKey, MachineReading>>;
  last: HostSample | undefined;
  status: ReturnType<typeof useLive>["status"];
  /** What the left end of every live chart says. */
  span: string;
  windowMs: number;
}

const HISTORY_KEYS = "cpu,temp.cpu";
/** Two hours of minute samples before anything is called "usual". */
const MIN_HISTORY = 120;
/** The live stream keeps 180 samples at 2 s. */
export const LIVE_WINDOW_MS = 6 * 60_000;

type History = Record<string, [number, number][]>;

/** The median, once there's enough history to call it usual. */
function usualOf(values: number[]): number | null {
  if (values.length < MIN_HISTORY) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) / 2)]!;
}

/** "11.4 GB" → ["11.4", "GB"]; "47 °C" → ["47", "°C"]; "47°C" → ["47", "°C"]. */
export function splitUnit(s: string): [string, string] {
  const m = /^([−-]?[\d.,]+)\s*(.*)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, ""];
}

export function useMachineReadings(): MachineReadings {
  const { host, status } = useLive();
  const fmt = useFormat();
  const { data: hist } = useApi<History>(`/api/metrics/history?keys=${HISTORY_KEYS}&range=24h`, { refresh: 10 * 60_000 });
  const last = host.at(-1);

  const usual = React.useMemo(
    () => ({
      cpu: usualOf((hist?.cpu ?? []).map((p) => p[1])),
      temp: usualOf((hist?.["temp.cpu"] ?? []).map((p) => p[1])),
    }),
    [hist],
  );

  const readings: MachineReadings["readings"] = {};
  if (last) {
    const peak = (pick: (h: HostSample) => number) => host.reduce((m, h) => Math.max(m, pick(h)), 0);
    const pct = (v: number) => `${Math.round(v)}%`;

    const threads = last.cores.length;
    const cpuUsual = usual.cpu !== null ? `usually ${pct(usual.cpu)}` : `peak ${pct(peak((h) => h.cpu))}`;
    readings.cpu = {
      key: "cpu",
      label: "Processor",
      value: String(Math.round(last.cpu)),
      unit: "%",
      context: threads ? `${threads} threads · ${cpuUsual}` : cpuUsual,
      points: host.map((h) => [h.t, h.cpu]),
      yMax: 100,
      format: pct,
    };

    const [mv, mu] = splitUnit(fmt.bytes(last.mem.used, 1));
    readings.mem = {
      key: "mem",
      label: "Memory",
      value: mv,
      unit: mu,
      context: `of ${fmt.bytes(last.mem.total)} · ${fmt.bytes(last.mem.available)} free`,
      points: host.map((h) => [h.t, h.mem.used]),
      yMax: last.mem.total,
      format: (v) => fmt.bytes(v, 1),
      axisFormat: (v) => fmt.bytes(v),
    };

    const [nv, nu] = splitUnit(fmt.rate(last.net.rx + last.net.tx));
    readings.net = {
      key: "net",
      label: "Network",
      value: nv,
      unit: nu,
      context: `${fmt.rate(last.net.rx)} in · ${fmt.rate(last.net.tx)} out`,
      points: host.map((h) => [h.t, h.net.rx + h.net.tx]),
      format: (v) => fmt.rate(v),
    };

    const [dv, du] = splitUnit(fmt.rate(last.disk.read + last.disk.write));
    readings.disk = {
      key: "disk",
      label: "Disks",
      value: dv,
      unit: du,
      context: `${fmt.rate(last.disk.read)} read · ${fmt.rate(last.disk.write)} write`,
      points: host.map((h) => [h.t, h.disk.read + h.disk.write]),
      format: (v) => fmt.rate(v),
    };

    if (last.temp !== null) {
      const [tv, tu] = splitUnit(fmt.temp(last.temp));
      const temps = host.filter((h) => h.temp !== null);
      readings.temp = {
        key: "temp",
        label: "Temperature",
        value: tv,
        unit: tu,
        context: `processor · ${usual.temp !== null ? `usually ${fmt.temp(usual.temp)}` : `peak ${fmt.temp(peak((h) => h.temp ?? 0))}`}`,
        points: temps.map((h) => [h.t, h.temp!]),
        yMax: 100,
        format: (v) => fmt.temp(v),
      };
    }
  }
  return {
    readings,
    last,
    status,
    span: "6 min ago",
    windowMs: LIVE_WINDOW_MS,
  };
}
