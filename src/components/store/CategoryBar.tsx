"use client";
import * as React from "react";
import s from "./store.module.css";

/**
 * Categories as a row of plain words with their counts (never pills); the chosen one is underlined
 * like a tab. "Installed" narrows any category to what's already on this server.
 */
export function CategoryBar({
  categories,
  value,
  onChange,
  installedOnly,
  onInstalledOnly,
  installedCount,
  updates,
  total,
}: {
  categories: { value: string; label: string; count: number }[];
  value: string;
  onChange: (v: string) => void;
  installedOnly: boolean;
  onInstalledOnly: (v: boolean) => void;
  installedCount: number;
  updates: number;
  total: number;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Keep the chosen category in view when the row scrolls (phones).
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[aria-pressed=true][data-cat]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <div className={s.cats} ref={ref} role="group" aria-label="Filter by category">
      {installedCount > 0 && (
        <>
          <button type="button" className={s.cat} aria-pressed={installedOnly} onClick={() => onInstalledOnly(!installedOnly)}>
            <span className={s.catLabel}>Installed</span>
            {updates > 0 && <span className={s.catUpdates} role="img" aria-label={`${updates} with updates`} />}
            <span className="num">{installedCount}</span>
          </button>
          <span className={s.catRule} aria-hidden />
        </>
      )}
      <button type="button" className={s.cat} data-cat="" aria-pressed={value === "all"} onClick={() => onChange("all")}>
        <span className={s.catLabel}>All</span>
        <span className="num">{total}</span>
      </button>
      {categories.map((c) => (
        <button key={c.value} type="button" className={s.cat} data-cat="" aria-pressed={value === c.value} onClick={() => onChange(c.value)}>
          <span className={s.catLabel}>{c.label}</span>
          <span className="num">{c.count}</span>
        </button>
      ))}
    </div>
  );
}
