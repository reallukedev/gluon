"use client";
import * as React from "react";
import type { MonitorCheck, MonitorView, StripBucket } from "@/lib/alerts-types";
import type { LineState } from "@/lib/types";
import { useFormat } from "@/components/PrefsProvider";
import s from "./trace.module.css";

/** Uptime as people read it: 100%, 99.93%, 97.4%. */
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "No data";
  if (v >= 99.995) return "100%";
  if (v >= 99) return `${v.toFixed(2)}%`;
  return `${v.toFixed(1)}%`;
}

export const ms = (v: number | null | undefined) => (v === null || v === undefined ? "No data" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

export function monitorLine(m: Pick<MonitorView, "state" | "consecutiveFailures" | "config" | "flapping">): { line: LineState; label: string } {
  switch (m.state) {
    case "up":
      return m.flapping ? { line: "attention", label: "Up, but unsteady" } : { line: "running", label: "Up" };
    case "down":
      return { line: "unhealthy", label: "Down" };
    case "failing":
      return { line: "starting", label: `Not answering (${m.consecutiveFailures} of ${m.config.failAfter})` };
    case "pending":
      return { line: "starting", label: "First check soon" };
    case "paused":
      return { line: "paused", label: "Paused" };
    case "idle":
      return { line: "stopped", label: "App is stopped" };
  }
}

/** Turn raw checks (newest first, as the API sends them) into one-check buckets, oldest first. */
export function checksToBuckets(checks: MonitorCheck[]): StripBucket[] {
  return [...checks].reverse().map((c) => ({
    start: c.at,
    checks: 1,
    ok: c.ok ? 1 : 0,
    ratio: c.ok ? 1 : 0,
    state: c.ok ? "up" : "down",
    avgMs: c.ok ? c.latencyMs : null,
  }));
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((e) => setW(Math.round(e[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface TraceProps {
  buckets: StripBucket[];
  /** Length of one bucket in ms; 0 = one check per bucket (times are exact). */
  bucketMs: number;
  /** Buckets that end before this weren't watched yet, so nothing is drawn for them. */
  since?: number;
  /** Accessible name: "Jellyfin, last 24 hours". */
  label: string;
  /** Draw the response-time line above the ticks. */
  latency?: boolean;
  /** Tall variant for the detail view. */
  tall?: boolean;
}

/**
 * A monitor's history drawn as a status-page strip: one hairline tick per bucket (faint = every check
 * passed, short red = checks failed, dashed = nothing was checked), with the response time as a thin
 * line on the same time axis above it. Hover or use the arrow keys to read any tick.
 */
export function Trace({ buckets, bucketMs, since = 0, label, latency = true, tall }: TraceProps) {
  const fmt = useFormat();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [cursor, setCursor] = React.useState<number | null>(null);
  const readoutId = React.useId();
  const n = buckets.length;

  const H = tall ? 56 : 32;
  const latH = latency ? (tall ? 24 : 12) : 0;
  const tickTop = latency ? latH + (tall ? 8 : 5) : 0;
  const tickBot = H - 1;
  const tickShort = tickBot - Math.max(5, Math.round((tickBot - tickTop) * 0.45));

  const pitch = n ? width / n : 0;
  const stroke = Math.max(1, Math.min(2, pitch * 0.5));
  const x = (i: number) => Math.round((i + 0.5) * pitch * 2) / 2;

  const watched = (b: StripBucket) => (bucketMs ? b.start + bucketMs > since : true);
  const failures = buckets.filter((b) => b.checks > 0 && b.ok < b.checks).length;

  const paths = React.useMemo(() => {
    if (!width || !n) return null;
    let ok = "";
    let bad = "";
    let gap = "";
    for (let i = 0; i < n; i++) {
      const b = buckets[i]!;
      if (!watched(b)) continue;
      const xi = x(i);
      if (b.checks === 0) gap += `M${xi} ${tickTop}V${tickBot}`;
      else if (b.ok === b.checks) ok += `M${xi} ${tickTop}V${tickBot}`;
      else bad += `M${xi} ${tickShort}V${tickBot}`;
    }
    let line = "";
    if (latency) {
      const vals = buckets.map((b) => b.avgMs).filter((v): v is number => v !== null);
      const max = Math.max(1, ...vals) * 1.15;
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = buckets[i]!.avgMs;
        if (v === null || !watched(buckets[i]!)) {
          pen = false;
          continue;
        }
        const y = (latH - 1.5 - (v / max) * (latH - 3)).toFixed(1);
        line += `${pen ? "L" : "M"}${x(i)} ${y}`;
        pen = true;
      }
    }
    return { ok, bad, gap, line };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, width, n, since, bucketMs, latency, tall]);

  const b = cursor !== null ? buckets[cursor] : null;
  const when = (t: number) => (bucketMs >= 3_600_000 ? `${fmt.date(t, { weekday: true })} ${fmt.time(t)}` : fmt.time(t, bucketMs === 0));
  const readout = b
    ? `${bucketMs ? `${when(b.start)}–${fmt.time(b.start + bucketMs)}` : when(b.start)} · ${
        !watched(b) ? "not watched yet" : b.checks === 0 ? "no checks" : bucketMs === 0 ? (b.ok ? "passed" : "failed") : b.ok === b.checks ? `all ${b.checks} checks passed` : `${b.checks - b.ok} of ${b.checks} checks failed`
      }${b.avgMs !== null ? ` · ${ms(b.avgMs)}` : ""}`
    : "";

  function pick(clientX: number) {
    const el = ref.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    setCursor(Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n))));
  }
  function onKey(e: React.KeyboardEvent) {
    if (!n) return;
    const cur = cursor ?? n - 1;
    const step = e.shiftKey ? 10 : 1;
    const next = e.key === "ArrowLeft" ? cur - step : e.key === "ArrowRight" ? cur + step : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) {
      if (e.key === "Escape") setCursor(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setCursor(Math.max(0, Math.min(n - 1, next)));
  }

  const summary = `${label}: ${failures ? `${fmt.plural(failures, bucketMs ? "stretch" : "check", bucketMs ? "stretches" : "checks")} with failures` : "no failures"}. Use the arrow keys to read each point.`;

  return (
    <div
      ref={ref}
      className={s.trace}
      data-tall={tall ? "" : undefined}
      style={{ height: H }}
      tabIndex={0}
      role="group"
      aria-label={summary}
      aria-describedby={b ? readoutId : undefined}
      onPointerMove={(e) => e.pointerType === "mouse" && pick(e.clientX)}
      onPointerDown={(e) => e.pointerType !== "mouse" && pick(e.clientX)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setCursor(null)}
      onFocus={() => setCursor((c) => c ?? n - 1)}
      onBlur={() => setCursor(null)}
      onKeyDown={onKey}
    >
      {paths && (
        <svg width={width} height={H} aria-hidden className={s.svg}>
          <line x1={0} x2={width} y1={tickBot + 0.5} y2={tickBot + 0.5} className={s.base} />
          {paths.line && <path d={paths.line} className={s.latency} />}
          <path d={paths.ok} className={s.ok} strokeWidth={stroke} />
          <path d={paths.gap} className={s.gap} strokeWidth={Math.min(stroke, 1.5)} />
          <path d={paths.bad} className={s.bad} strokeWidth={Math.max(1.5, stroke)} />
          {cursor !== null && <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={H} className={s.cursor} />}
        </svg>
      )}
      {b && (
        <span id={readoutId} className={s.readout} role="status" data-side={cursor! > n / 2 ? "end" : "start"}>
          {readout}
        </span>
      )}
    </div>
  );
}

/** The legend under a trace: what each mark means, drawn with the marks themselves. */
export function TraceLegend({ latency = true }: { latency?: boolean }) {
  return (
    <div className={s.legend} aria-hidden>
      <span>
        <i className={s.lgOk} /> answered
      </span>
      <span>
        <i className={s.lgBad} /> failed
      </span>
      <span>
        <i className={s.lgGap} /> not checked
      </span>
      {latency && (
        <span>
          <i className={s.lgLat} /> response time
        </span>
      )}
    </div>
  );
}
