"use client";
import * as React from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { OpenNewWindow } from "iconoir-react";
import { AppIcon } from "@/components/apps/AppIcon";
import { StateLine } from "@/components/ui/StateLine";
import { currentLine } from "@/components/apps/umbrelStream";
import { categoryName, type InstalledInfo, type StoreEntry } from "./types";
import type { InstallRun } from "./StoreView";
import { installedLine } from "./status";
import s from "./store.module.css";

const MIN_CARD = 280;
const GAP = 12;

/** The store's app cards, virtualised by row: the official store alone lists hundreds of apps. */
export function StoreGrid({
  entries,
  installedInfo,
  runs,
  onOpen,
}: {
  entries: StoreEntry[];
  installedInfo: (e: StoreEntry) => InstalledInfo | null;
  runs: Record<string, InstallRun>;
  onOpen: (id: string, store: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [margin, setMargin] = React.useState(0);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Anything above the grid (header, toolbar) moves it; keep the virtualiser's offset in step.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = Math.round(el.getBoundingClientRect().top + window.scrollY);
    if (Math.abs(m - margin) > 1) setMargin(m);
  });

  const cols = width ? Math.max(1, Math.floor((width + GAP) / (MIN_CARD + GAP))) : 1;
  const rows = Math.ceil(entries.length / cols);
  const v = useWindowVirtualizer({ count: rows, estimateSize: () => 148 + GAP, overscan: 4, scrollMargin: margin });
  React.useEffect(() => v.measure(), [cols, v]);

  return (
    <div ref={ref} className={s.grid} style={{ height: v.getTotalSize() }} role="list" aria-label="Apps">
      {v.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={v.measureElement}
          className={s.gridRow}
          style={{ transform: `translateY(${row.start - margin}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {entries.slice(row.index * cols, row.index * cols + cols).map((e, i) => (
            <Card key={e.key} entry={e} installed={installedInfo(e)} run={runs[e.app.id]} onOpen={onOpen} pos={row.index * cols + i + 1} total={entries.length} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Card({
  entry,
  installed,
  run,
  onOpen,
  pos,
  total,
}: {
  entry: StoreEntry;
  installed: InstalledInfo | null;
  run: InstallRun | undefined;
  onOpen: (id: string, store: string) => void;
  pos: number;
  total: number;
}) {
  const { app, store } = entry;
  const installing = run?.running;
  const status = installing ? { line: "starting" as const, label: currentLine(run.state) ?? "Installing" } : installed ? installedLine(installed) : null;
  // Real progress only: Umbrel's percentage from this install's stream, or from its app state.
  const pct = installing ? (run.state.progress && run.state.progress.total ? (run.state.progress.done / run.state.progress.total) * 100 : null) : installed && (installed.state === "installing" || installed.state === "updating") ? installed.progress : null;
  const working = installing || (installed && (installed.state === "installing" || installed.state === "updating" || installed.state === "uninstalling"));
  return (
    <article className={s.card} role="listitem" aria-posinset={pos} aria-setsize={total}>
      <AppIcon src={app.icon} name={app.name} size={44} />
      <div className={s.cardText}>
        <h2 className={s.cardName}>
          <button type="button" className={s.cardButton} onClick={() => onOpen(app.id, store.id)} title={app.name}>
            {app.name}
          </button>
        </h2>
        <p className={s.cardDev} title={store.official ? app.developer : `${app.developer} · ${store.name}, a community store`}>
          {app.developer || "Unknown developer"}
          {!store.official && <span className={s.community}> · {store.name}</span>}
        </p>
        <p className={s.cardTagline}>{app.tagline || app.description.split("\n")[0]}</p>
        <div className={s.cardFoot}>
          {status ? <StateLine state={status.line} size={12} label={status.label} /> : <span className={s.cardCategory}>{categoryName(app.category)}</span>}
          {installed?.url && !installing && (
            <a href={installed.url} target="_blank" rel="noopener noreferrer" className={s.cardOpen} aria-label={`Open ${app.name}`}>
              Open
              <OpenNewWindow aria-hidden />
            </a>
          )}
        </div>
      </div>
      {working && (
        <span className={s.cardProgress} role="progressbar" aria-label={`${status?.label ?? "Working"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <span style={pct !== null ? { transform: `scaleX(${pct / 100})` } : undefined} data-indeterminate={pct === null ? "" : undefined} />
        </span>
      )}
    </article>
  );
}
