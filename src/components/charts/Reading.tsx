"use client";
import { useFormat } from "@/components/PrefsProvider";
import { TimeChart } from "./TimeChart";
import type { MachineReading } from "./readings";
import r from "./reading.module.css";

/**
 * One machine reading: the figure, a line of context in numbers, and its last few minutes as a
 * chart with a scale. `sm` puts the label and figure on one row for small tiles.
 */
export function Reading({
  reading,
  span,
  windowMs,
  size = "md",
  chartHeight,
  ground = "panel",
  times = true,
}: {
  reading: MachineReading;
  span: string;
  windowMs: number;
  size?: "sm" | "md";
  chartHeight?: number;
  /** What the reading sits on, so the chart's end dot rings in the right colour. */
  ground?: "panel" | "ground";
  /** Label the chart's time axis; the smallest tiles leave it off. */
  times?: boolean;
}) {
  const fmt = useFormat();
  const g = reading;
  return (
    <div className={r.reading} data-size={size} data-ground={ground} aria-label={`${g.label}: ${g.value}${g.unit === "%" ? "%" : ` ${g.unit}`}, ${g.context}`} role="group">
      <div className={r.head} aria-hidden>
        <span className={r.label}>{g.label}</span>
        <span className={r.figure}>
          {g.value}
          {g.unit && <small data-tight={g.unit === "%" || g.unit.startsWith("°") ? "" : undefined}>{g.unit}</small>}
        </span>
      </div>
      <p className={r.context} aria-hidden>
        {/* Parts never break inside, so a narrow tile wraps at the dots. */}
        {g.context.split(" · ").map((part, i) => (
          <span key={i}>
            {i > 0 && " · "}
            <span className={r.part}>{part}</span>
          </span>
        ))}
      </p>
      <div className={r.chart}>
        <TimeChart
          series={[{ key: g.key, label: g.label, points: g.points, area: true }]}
          yMax={g.yMax}
          format={g.format}
          axisFormat={g.axisFormat}
          formatTime={(t) => fmt.time(t, true)}
          windowMs={windowMs}
          live
          edge
          span={span}
          times={times}
          height={chartHeight ?? (size === "sm" ? 40 : 56)}
          label={`${g.label}, last 6 minutes`}
        />
      </div>
    </div>
  );
}
