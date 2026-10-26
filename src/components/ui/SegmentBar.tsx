"use client";
/**
 * SegmentBar: one bar split into labelled parts: memory by app, a disk by folder, space by user.
 *
 *   <SegmentBar
 *     label="Memory by app"
 *     total={memTotal}
 *     segments={apps.map((a) => ({ key: a.id, label: a.name, value: a.mem }))}
 *     format={fmt.bytes}
 *     summary={`${fmt.bytes(used)} of ${fmt.bytes(memTotal)} in use`}
 *   />
 *
 * - Parts are drawn in ink at stepped strengths with 1px plate gaps; what is left of `total`
 *   stays as the sunk track. `tone: "attn" | "fault"` marks a part that needs you or is broken
 *   (the readout names it, so colour is never the only signal).
 * - Hover or focus a part (or its legend row) to isolate it: the others drop back and the readout
 *   above the bar names it with its value and share. Arrow keys walk the parts; Escape clears.
 * - `onSelect(key)` makes parts clickable (e.g. open that app).
 * - Values are data: they never animate. Only the isolation fades (150ms).
 */
import * as React from "react";
import s from "./segmentBar.module.css";

export interface Segment {
  key: string;
  label: string;
  value: number;
  tone?: "ink" | "attn" | "fault";
  /** Extra words for the readout, e.g. "3 containers". */
  meta?: string;
}

interface SegmentBarProps {
  label: string;
  segments: Segment[];
  /** The whole (e.g. total memory). Defaults to the sum of the parts. */
  total?: number;
  format: (v: number) => string;
  /** What the readout says when nothing is isolated. */
  summary?: React.ReactNode;
  /** Name for the unused remainder in the legend, e.g. "Free". Omit to leave it unlabelled. */
  restLabel?: string;
  legend?: boolean;
  /** Bar thickness in px (default 12). */
  height?: number;
  onSelect?: (key: string) => void;
  /** Show at most this many parts; the smallest are folded into "Everything else". */
  max?: number;
}

const STEPS = [1, 0.72, 0.52, 0.38, 0.28];

export function SegmentBar({ label, segments, total, format, summary, restLabel, legend = true, height = 12, onSelect, max = 12 }: SegmentBarProps) {
  const [active, setActive] = React.useState<number | null>(null);
  const id = React.useId();

  const parts = React.useMemo(() => {
    const clean = segments.filter((x) => Number.isFinite(x.value) && x.value > 0).sort((a, b) => b.value - a.value);
    if (clean.length <= max) return clean;
    const head = clean.slice(0, max - 1);
    const rest = clean.slice(max - 1).reduce((n, x) => n + x.value, 0);
    return [...head, { key: "__other", label: "Everything else", value: rest, meta: `${clean.length - head.length} more` }];
  }, [segments, max]);

  const sum = parts.reduce((n, x) => n + x.value, 0);
  const whole = Math.max(total ?? sum, sum, 0);
  const rest = whole - sum;
  const pct = (v: number) => (whole > 0 ? (v / whole) * 100 : 0);
  const pctText = (v: number) => {
    const p = pct(v);
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };

  const cur = active !== null ? parts[active] : undefined;
  const clickable = !!onSelect;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!parts.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a === null ? 0 : Math.min(parts.length - 1, a + 1)));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a === null ? parts.length - 1 : Math.max(0, a - 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(parts.length - 1);
    } else if (e.key === "Escape") {
      setActive(null);
    } else if ((e.key === "Enter" || e.key === " ") && cur && onSelect && cur.key !== "__other") {
      e.preventDefault();
      onSelect(cur.key);
    }
  };

  return (
    <div className={s.root} data-active={active !== null ? "" : undefined}>
      <div className={s.readout} id={`${id}-readout`} aria-live="polite">
        {cur ? (
          <>
            <span className={s.readName} data-tone={cur.tone}>
              {cur.label}
            </span>
            <span className="num">{format(cur.value)}</span>
            <span className={`${s.readPct} num`}>{pctText(cur.value)}</span>
            {cur.meta && <span className={s.readMeta}>{cur.meta}</span>}
          </>
        ) : (
          <span className={s.readSummary}>{summary ?? `${format(sum)}${total !== undefined ? ` of ${format(whole)}` : ""}`}</span>
        )}
      </div>
      <div
        className={s.bar}
        style={{ height }}
        role="group"
        aria-label={`${label}. Use the arrow keys to go through the parts.`}
        aria-describedby={`${id}-readout`}
        tabIndex={parts.length ? 0 : -1}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {parts.map((p, i) => (
          <span
            key={p.key}
            className={s.part}
            data-tone={p.tone}
            data-on={active === i ? "" : undefined}
            data-clickable={clickable && p.key !== "__other" ? "" : undefined}
            style={{ flexGrow: p.value, "--step": STEPS[i % STEPS.length] } as React.CSSProperties}
            onPointerEnter={() => setActive(i)}
            onClick={() => clickable && p.key !== "__other" && onSelect?.(p.key)}
            aria-hidden
            title={`${p.label}: ${format(p.value)} (${pctText(p.value)})`}
          />
        ))}
        {rest > 0 && <span className={s.rest} style={{ flexGrow: rest }} aria-hidden />}
      </div>
      {legend && parts.length > 0 && (
        <ul className={s.legend}>
          {parts.map((p, i) => (
            <li
              key={p.key}
              data-on={active === i ? "" : undefined}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            >
              <i className={s.swatch} data-tone={p.tone} style={{ "--step": STEPS[i % STEPS.length] } as React.CSSProperties} aria-hidden />
              <span className={s.legendLabel}>{p.label}</span>
              <span className={`${s.legendValue} num`}>{format(p.value)}</span>
            </li>
          ))}
          {rest > 0 && restLabel && (
            <li className={s.legendRest}>
              <i className={s.swatch} data-rest="" aria-hidden />
              <span className={s.legendLabel}>{restLabel}</span>
              <span className={`${s.legendValue} num`}>{format(rest)}</span>
            </li>
          )}
        </ul>
      )}
      {/* The whole picture for screen readers. */}
      <ul className="sr-only" aria-label={label}>
        {parts.map((p) => (
          <li key={p.key}>
            {p.label}: {format(p.value)}, {pctText(p.value)}
            {p.tone === "attn" ? ", needs you" : p.tone === "fault" ? ", has a problem" : ""}
          </li>
        ))}
        {rest > 0 && restLabel && (
          <li>
            {restLabel}: {format(rest)}
          </li>
        )}
      </ul>
    </div>
  );
}
