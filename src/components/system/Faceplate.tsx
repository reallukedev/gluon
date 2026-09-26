"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { MemoryBreakdown, SystemOverview } from "@/lib/system-types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Skeleton } from "@/components/ui/Surface";
import { SegmentBar } from "@/components/ui/SegmentBar";
import f from "./faceplate.module.css";

/**
 * The machine as an instrument plate: every processor thread as a live hairline, memory as one
 * bar split by app, and every temperature sensor on one graduated scale with its limits ticked.
 */
export function Faceplate({ overview }: { overview: SystemOverview }) {
  return (
    <div className={f.plate}>
      <CpuThreads overview={overview} />
      <MemoryBar overview={overview} />
      <TempScale overview={overview} />
    </div>
  );
}

// ---------------------------------------------------------------- processor

function CpuThreads({ overview }: { overview: SystemOverview }) {
  const { host, status } = useLive();
  const last = host.at(-1);
  const [focus, setFocus] = React.useState<number | null>(null);
  const threads = overview.cpu.threads;
  const cores = last?.cores.length ? last.cores : null;
  const n = cores?.length ?? threads;
  const avg = last ? Math.round(last.cpu) : null;
  // The busiest moment of each thread over the last ~3 minutes, drawn as a faint cap.
  const peaks = React.useMemo(() => {
    const out = new Array<number>(n).fill(0);
    for (const h of host.slice(-60)) h.cores.forEach((v, i) => (out[i] = Math.max(out[i] ?? 0, v)));
    return out;
  }, [host, n]);

  const readout =
    focus !== null && cores ? (
      <>
        Thread <span className="num">{focus + 1}</span> · <span className="num">{Math.round(cores[focus] ?? 0)}%</span>
        <span className={f.dim}> · busiest lately {Math.round(peaks[focus] ?? 0)}%</span>
      </>
    ) : last ? (
      <>
        Load <span className="num">{last.load.map((l) => l.toFixed(2)).join(" · ")}</span>
        <span className={f.dim}> over 1, 5 and 15 min</span>
      </>
    ) : (
      <span className={f.dim}>{status === "offline" ? "Live numbers paused" : "Reading…"}</span>
    );

  return (
    <section className={f.instrument} aria-labelledby="fp-cpu">
      <header className={f.head}>
        <h3 id="fp-cpu" className={f.label}>
          Processor
        </h3>
        <span className={f.figure}>
          {avg === null ? <Skeleton width={48} height={26} /> : <span className="num">{avg}</span>}
          <small>%</small>
        </span>
      </header>
      <div
        className={f.threads}
        role="img"
        aria-label={cores ? `${n} threads: ${cores.map((c, i) => `${i + 1}: ${Math.round(c)}%`).join(", ")}` : `${n} threads`}
        style={{ "--n": n } as React.CSSProperties}
        onPointerLeave={() => setFocus(null)}
      >
        {Array.from({ length: n }, (_, i) => {
          const v = cores?.[i] ?? 0;
          return (
            <span key={i} className={f.thread} data-dim={focus !== null && focus !== i ? "" : undefined} onPointerEnter={() => setFocus(i)}>
              <i
                className={f.threadPeak}
                style={{
                  transform: `translateY(${(1 - Math.max(0.02, (peaks[i] ?? 0) / 100)) * 100}%)`,
                }}
              />
              <i className={f.threadFill} style={{ transform: `scaleY(${Math.max(0.02, v / 100)})` }} />
            </span>
          );
        })}
      </div>
      <p className={f.readout}>{readout}</p>
      <p className={f.caption}>
        {overview.cpu.cores ? `${overview.cpu.cores} cores, ` : ""}
        {threads} threads
        {overview.cpu.model ? ` · ${shortCpu(overview.cpu.model)}` : ""}
      </p>
    </section>
  );
}

function shortCpu(model: string) {
  return model
    .replace(/\((R|TM|tm)\)/g, "")
    .replace(/\bCPU\b/g, "")
    .replace(/\s+@.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- memory

function MemoryBar({ overview }: { overview: SystemOverview }) {
  const fmt = useFormat();
  const router = useRouter();
  const { data } = useApi<MemoryBreakdown>("/api/system/memory", {
    refresh: 10_000,
  });
  const total = data?.total ?? overview.memory.total;
  const used = data?.used ?? overview.memory.used;
  const high = total ? used / total >= 0.9 : false;
  const appsTotal = data ? data.apps.reduce((a, x) => a + x.bytes, 0) : 0;
  const apps = new Set(data?.apps.map((a) => a.id));

  return (
    <section className={f.instrument} aria-labelledby="fp-mem">
      <header className={f.head}>
        <h3 id="fp-mem" className={f.label}>
          Memory
        </h3>
        <span className={f.figure}>
          <span className="num">{fmt.bytes(used)}</span>
          <small>of {fmt.bytes(total)}</small>
        </span>
      </header>
      {data ? (
        <div className="appear">
          <SegmentBar
            label="Memory in use, by app"
            total={total}
            height={14}
            max={6}
            format={(v) => fmt.bytes(v)}
            restLabel="Free"
            summary={
              <>
                Apps <span className="num">{fmt.bytes(appsTotal)}</span> · system <span className="num">{fmt.bytes(data.other)}</span> · <span className="num">{fmt.bytes(data.available)}</span> free
              </>
            }
            segments={[
              ...data.apps.map((a) => ({
                key: a.id,
                label: a.name,
                value: a.bytes,
                tone: high ? ("attn" as const) : undefined,
                meta: "click to open",
              })),
              {
                key: "_system",
                label: "System and other programs",
                value: data.other,
                meta: "not an app",
              },
            ]}
            onSelect={(key) => {
              if (apps.has(key)) router.push(`/apps/${encodeURIComponent(key)}`);
            }}
          />
        </div>
      ) : (
        <Skeleton height={80} radius={6} />
      )}
      <p className={f.caption}>
        {data && data.swap.total > 0 ? (
          <>
            Swap <span className="num">{fmt.bytes(data.swap.used)}</span> of <span className="num">{fmt.bytes(data.swap.total)}</span>
            {data.swap.used > data.swap.total * 0.5 ? " · the machine is short of memory" : ""}
          </>
        ) : null}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- temperatures

interface TempGroup {
  key: string;
  name: string;
  min: number;
  max: number;
  count: number;
  high: number | null;
  crit: number | null;
  detail: string;
}

const CHIP_NAMES: [RegExp, string][] = [
  [/^(coretemp|k10temp|zenpower|cpu_thermal|cpu-thermal|soc_thermal)$/, "Processor"],
  [/^(nouveau|amdgpu|radeon|nvidia|i915)$/, "Graphics card"],
  [/^(nvme)$/, "NVMe drive"],
  [/^(drivetemp)$/, "Drive"],
  [/^(acpitz|pch_\w+)$/, "Motherboard"],
  [/^(dell_smm|thinkpad|asus\w*|nct\d+|it87\w*)$/, "Fan controller"],
  [/^(iwlwifi\w*|ath\w+|mt7\w+)$/, "Wi-Fi"],
];

function tempGroups(o: SystemOverview): TempGroup[] {
  const map = new Map<string, TempGroup>();
  for (const t of o.temperatures) {
    const base = CHIP_NAMES.find(([re]) => re.test(t.chip))?.[1] ?? t.chip;
    const isCore = /^core\s*\d+$/i.test(t.label);
    const key = `${t.chip}:${isCore ? "cores" : /package|tctl|tdie/i.test(t.label) ? "pkg" : base === "Motherboard" || base === "Graphics card" ? "all" : t.label}`;
    const name = isCore ? "Cores" : base === "Fan controller" ? (/cpu/i.test(t.label) ? "Fan sensor, CPU" : "Fan sensor") : base;
    const g = map.get(key);
    if (g) {
      g.min = Math.min(g.min, t.celsius);
      g.max = Math.max(g.max, t.celsius);
      g.count++;
      g.high ??= t.high;
      g.crit ??= t.crit;
    } else
      map.set(key, {
        key,
        name,
        min: t.celsius,
        max: t.celsius,
        count: 1,
        high: t.high,
        crit: t.crit,
        detail: t.chip,
      });
  }
  return [...map.values()].sort((a, b) => b.max - a.max);
}

function TempScale({ overview }: { overview: SystemOverview }) {
  const fmt = useFormat();
  const groups = tempGroups(overview);
  if (!groups.length) {
    return (
      <section className={f.instrument} aria-labelledby="fp-temp">
        <header className={f.head}>
          <h3 id="fp-temp" className={f.label}>
            Temperatures
          </h3>
        </header>
        <p className={f.emptyNote}>This machine doesn't report temperatures to Linux. Installing lm-sensors and running sensors-detect over SSH can find more.</p>
      </section>
    );
  }
  const lo = 20;
  const hi = Math.max(100, ...groups.map((g) => Math.min(125, (g.crit ?? g.max) + 5)), ...groups.map((g) => g.max + 5));
  const top = Math.ceil(hi / 10) * 10;
  const at = (c: number) => `${((Math.min(top, Math.max(lo, c)) - lo) / (top - lo)) * 100}%`;
  const ticks: number[] = [];
  for (let c = lo; c <= top; c += 5) ticks.push(c);
  const hottest = groups[0]!;
  const level = (g: TempGroup) => (g.crit && g.max >= g.crit - 2 ? "fault" : g.high && g.max >= g.high ? "attention" : "normal");

  return (
    <section className={`${f.instrument} ${f.tempInstrument}`} aria-labelledby="fp-temp">
      <header className={f.head}>
        <h3 id="fp-temp" className={f.label}>
          Temperatures
        </h3>
        <span className={f.figure}>
          <span className="num">{fmt.temp(hottest.max)}</span>
          <small>hottest · {hottest.name}</small>
        </span>
      </header>
      <div className={f.scale} aria-hidden>
        <div className={f.scaleName} />
        <div className={f.ruler}>
          {ticks.map((c) => (
            <span key={c} className={f.tick} data-major={c % 20 === 0 ? "" : undefined} style={{ left: at(c) }}>
              {c % 20 === 0 && <b className="num">{c === top - (top % 20) ? fmt.temp(c).replace(/\s/g, "") : fmt.temp(c).replace(/[^\d.-]/g, "")}</b>}
            </span>
          ))}
        </div>
      </div>
      <ul className={f.temps}>
        {groups.map((g) => {
          const lv = level(g);
          const value = g.count > 1 && g.max - g.min >= 1 ? `${Math.round(g.min)}–${fmt.temp(g.max)}` : fmt.temp(g.max);
          const limits = [g.high ? `hot at ${fmt.temp(g.high)}` : null, g.crit ? `shuts down near ${fmt.temp(g.crit)}` : null].filter(Boolean).join(", ");
          return (
            <li key={g.key} className={f.tempRow} data-level={lv} title={`${g.name}${g.count > 1 ? ` (${g.count} sensors)` : ""}: ${value}${limits ? `. ${limits}` : ""}. Sensor: ${g.detail}`}>
              <span className={f.tempName}>
                {g.name}
                {g.count > 1 ? <span className={f.dim}> · {g.count}</span> : null}
              </span>
              <span className={f.tempTrack} aria-hidden>
                <i className={f.tempLine} style={{ width: at(g.max) }} />
                {g.count > 1 && (
                  <i
                    className={f.tempRange}
                    style={{
                      left: at(g.min),
                      width: `calc(${at(g.max)} - ${at(g.min)})`,
                    }}
                  />
                )}
                <i className={f.tempMark} style={{ left: at(g.max) }} />
                {g.high && <i className={f.limit} data-kind="high" style={{ left: at(g.high) }} />}
                {g.crit && <i className={f.limit} data-kind="crit" style={{ left: at(g.crit) }} />}
              </span>
              <span className={`${f.tempValue} num`}>
                {lv === "fault" && <span className={f.faultGlyph} aria-hidden />}
                {value}
              </span>
              <span className="sr-only">{limits ? `${limits}.` : ""}</span>
            </li>
          );
        })}
      </ul>
      <p className={f.caption}>
        <i className={f.legendHigh} aria-hidden /> hot · <i className={f.legendCrit} aria-hidden /> critical, where the chip protects itself
      </p>
    </section>
  );
}
