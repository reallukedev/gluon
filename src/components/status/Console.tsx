"use client";
import * as React from "react";
import Link from "next/link";
import type { StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { useAppUsage } from "@/components/apps/Meters";
import c from "./console.module.css";

/**
 * The server as a mixing desk: one channel strip per app with a live processor meter, a
 * peak-hold tick for the last 30 seconds, and memory underneath; the whole machine is the
 * master strip at the end. Levels use a log scale so a 0.5% app still reads, and a busy one
 * still fits. Every strip is labelled, so it reads without a legend.
 */

const PEAK_SAMPLES = 6; // container samples arrive every 5 s
const MARKS = [100, 50, 10, 1] as const;

/** 0–100 % → 0–1 on a log scale (1% ≈ 0.15, 10% ≈ 0.52, 50% ≈ 0.85). */
export const level = (pct: number) => Math.min(1, Math.max(0, Math.log10(1 + Math.max(0, pct)) / Math.log10(101)));

interface Strip {
  id: string;
  name: string;
  icon: string | null;
  href: string;
  cpu: number | null;
  peak: number | null;
  mem: number | null;
  tone: "running" | "stopped" | "fault" | "attention";
  note: string;
}

export function Console({ apps, findings }: { apps: StatusApp[]; findings: Finding[] }) {
  const fmt = useFormat();
  const { host } = useLive();
  const byId = React.useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const shown = React.useMemo(() => apps.filter((a) => a.containers.length && !(a.copyOf && byId.has(a.copyOf.id))), [apps, byId]);
  const usage = useAppUsage(shown);
  const faults = new Map(findings.filter((f) => f.subject).map((f) => [f.subject!, f]));

  const strips: Strip[] = shown.map((a) => {
    const u = usage.get(a.id);
    const f = faults.get(a.id);
    const stopped = a.line === "stopped" && !f;
    const tone: Strip["tone"] = f?.severity === "fault" || a.line === "unhealthy" ? "fault" : f ? "attention" : stopped ? "stopped" : "running";
    const peak = u ? Math.max(...u.cpuSeries.slice(-PEAK_SAMPLES), u.cpu) : null;
    return {
      id: a.id,
      name: a.name,
      icon: a.icon,
      href: `/apps/${encodeURIComponent(a.id)}`,
      cpu: u?.cpu ?? null,
      peak,
      mem: u?.mem ?? null,
      tone,
      note: tone === "fault" ? (f?.title.replace(/\.$/, "") ?? a.summary) : tone === "attention" ? (f?.title.replace(/\.$/, "") ?? "Needs you") : stopped ? "Stopped" : a.summary,
    };
  });
  const order = (s: Strip) => (s.tone === "fault" ? 0 : s.tone === "attention" ? 1 : s.tone === "running" ? 2 : 3);
  strips.sort((x, y) => order(x) - order(y) || x.name.localeCompare(y.name));

  const last = host.at(-1);
  const hostPeak = host.length ? Math.max(...host.slice(-15).map((h) => h.cpu)) : null;

  return (
    <div className={c.desk}>
      <div className={c.scale} aria-hidden>
        {MARKS.map((m) => (
          <span key={m} style={{ bottom: `${level(m) * 100}%` }}>
            {m}
          </span>
        ))}
        <span style={{ bottom: 0 }}>0</span>
      </div>
      <div className={c.bridge}>
        <div className={c.track}>
          <span className={c.grads} aria-hidden>
            {MARKS.map((m) => (
              <i key={m} style={{ bottom: `${level(m) * 100}%` }} />
            ))}
            <i data-floor="" style={{ bottom: 0 }} />
          </span>
          <ul className={c.strips} role="list" aria-label="Processor use by app, live">
            {strips.map((s) => (
              <li key={s.id} className={c.strip} data-tone={s.tone}>
                <Link
                  href={s.href}
                  className={c.link}
                  aria-label={`${s.name}: ${s.tone === "stopped" ? "stopped" : `${s.cpu !== null ? fmt.percent(s.cpu, 1) : "no reading"} of the processor${s.mem !== null ? `, ${fmt.bytes(s.mem)} memory` : ""}`}${s.tone === "fault" || s.tone === "attention" ? `. ${s.note}` : ""}`}
                  title={s.note}
                >
                  <AppIcon src={s.icon} name={s.name} size={24} />
                  <Meter value={s.cpu} peak={s.peak} />
                  <span className={`${c.read} num`}>{s.cpu !== null ? fmt.percent(s.cpu, s.cpu < 10 ? 1 : 0) : s.tone === "running" ? "…" : "off"}</span>
                  <span className={`${c.mem} num`}>{s.mem !== null && s.tone !== "stopped" ? fmt.bytes(s.mem, 0) : " "}</span>
                  <span className={c.name}>
                    {(s.tone === "fault" || s.tone === "attention") && <i className={c.mark} aria-hidden />}
                    {s.name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className={c.master}>
            <Link href="/system" className={c.link} aria-label={`Whole machine: ${last ? fmt.percent(last.cpu, 0) : "no reading"} of the processor${last ? `, ${fmt.bytes(last.mem.used)} of ${fmt.bytes(last.mem.total, 0)} memory` : ""}`}>
              <span className={c.masterGlyph} aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <Meter value={last?.cpu ?? null} peak={hostPeak} master />
              <span className={`${c.read} num`}>{last ? fmt.percent(last.cpu, 0) : "…"}</span>
              <span className={`${c.mem} num`}>{last ? fmt.bytes(last.mem.used, 0) : " "}</span>
              <span className={c.name}>Whole machine</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Meter({ value, peak, master }: { value: number | null; peak: number | null; master?: boolean }) {
  const v = value === null ? 0 : level(value);
  const p = peak === null ? null : level(peak);
  return (
    <span className={c.meter} data-master={master ? "" : undefined} aria-hidden>
      <span className={c.fill} style={{ transform: `scaleY(${Math.max(v, value === null ? 0 : 0.02)})` }} />
      {p !== null && p > 0.02 && (
        <span className={c.peakRail} style={{ transform: `translateY(${-p * 100}%)` }}>
          <span className={c.peak} />
        </span>
      )}
    </span>
  );
}
