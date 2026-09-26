"use client";
import * as React from "react";
import Link from "next/link";
import { Folder, Page as PageIcon, OpenNewWindow, NavArrowRight, ArrowUpLeft } from "iconoir-react";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { StorageJob, UsageChildren, UsageResult } from "@/lib/storage-types";
import { errorText } from "./VolumeDialogs";
import { filesHref } from "./shared";
import { SpaceMap, hintsFor, type Block, type SpaceHint } from "./SpaceMap";
import { keepFor, useCleanupActions } from "./CleanupPanel";
import s from "./storage.module.css";

interface UsageInfo {
  path: string;
  latest: StorageJob | null;
  running: StorageJob | null;
}

export interface MountChoice {
  path: string;
  /** For the drive picker: "2.0 TB hard drive · /mnt/hdd1". */
  label: string;
  /** For sentences and the breadcrumb: "2.0 TB hard drive" or "/var". */
  short?: string;
  /** How full it is, so the map opens on the drive that most needs looking at. */
  pct?: number;
}

function rootFor(path: string, mounts: MountChoice[]): string {
  let best = "/";
  for (const m of mounts) if ((path === m.path || path.startsWith(`${m.path}/`) || m.path === "/") && m.path.length >= best.length) best = m.path;
  return best;
}

const MB = 1_000_000;
const LIST_N = 10;

/** Cleanups Gluon knows how to do, placed on the folder where the space is. */
function useHints(onChanged?: () => void): { hints: SpaceHint[]; node: React.ReactNode } {
  const fmt = useFormat();
  const a = useCleanupActions(onChanged);
  const d = a.data;
  const hints: SpaceHint[] = [];
  if (d?.leftovers) {
    d.leftovers.paths.forEach((p, i) => hints.push({ path: p, bytes: d.leftovers!.sizes?.[p] ?? (i === 0 ? d.leftovers!.bytes : 0), title: "An old copy of Docker's storage that nothing uses", action: `Free ${fmt.bytes(d.leftovers!.bytes)}`, run: a.leftovers }));
  }
  if (d && d.apt.bytes >= MB) hints.push({ path: "/var/cache/apt", bytes: d.apt.bytes, title: "Update packages apt already installed", action: `Clear ${fmt.bytes(d.apt.bytes)}`, run: a.apt });
  if (d) {
    const keep = keepFor(d);
    if (d.journal.bytes - keep > 50 * MB) hints.push({ path: "/var/log/journal", bytes: d.journal.bytes - keep, title: `The system log, beyond the newest ${fmt.bytes(keep)}`, action: `Shrink to ${fmt.bytes(keep)}`, run: () => a.journal(keep) });
  }
  const dk = d?.docker;
  if (dk && d?.dockerRoot) {
    const bytes = dk.danglingImages.reduce((x, i) => x + i.bytes, 0) + dk.buildCache.bytes + dk.stoppedContainers.reduce((x, c) => x + c.bytes, 0);
    if (bytes > 50 * MB) {
      hints.push({
        path: d.dockerRoot,
        bytes,
        title: "Unused Docker images, build cache and stopped containers",
        action: "Choose what goes",
        run: () => {
          const el = document.getElementById("cleanup-docker");
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          el?.focus({ preventScroll: true });
        },
      });
    }
  }
  return { hints, node: a.confirmNode };
}

/**
 * "What's using space": a map of a drive's folders (two levels at a time), with cleanups hung on the
 * blocks they'd shrink, a readout for the block under the pointer, and the plain list underneath.
 * Scans run in the background; drilling into a folder shows what's already known right away.
 */
export function UsagePanel({ mounts, initialPath, onChanged }: { mounts: MountChoice[]; initialPath: string | null; onChanged?: () => void }) {
  const fmt = useFormat();
  const [path, setPath] = React.useState(() => initialPath ?? [...mounts].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0]?.path ?? "/");
  const [autoScan, setAutoScan] = React.useState(!!initialPath);
  const [starting, setStarting] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState<Block | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const { data, error, mutate, isLoading } = useApi<UsageInfo>(`/api/storage/usage?path=${encodeURIComponent(path)}`, { refresh: running ? 1500 : 0 });
  const { hints, node: confirmNode } = useHints(onChanged);
  /** Second-level results seen so far, so a drill shows something before its own scan is done. */
  const known = React.useRef(new Map<string, UsageChildren>());

  React.useEffect(() => {
    if (initialPath) {
      setPath(initialPath);
      setAutoScan(true);
    }
  }, [initialPath]);

  React.useEffect(() => setRunning(!!data?.running), [data?.running]);

  const start = React.useCallback(async () => {
    setStarting(true);
    try {
      await api.post("/api/storage/usage", { path });
      setRunning(true);
      await mutate();
    } catch (e) {
      const m = errorText(e);
      if (m) toast.error(m);
    } finally {
      setStarting(false);
    }
  }, [path, mutate]);

  // Opened from "See what's using it" or by drilling in: scan right away if there's no recent answer.
  React.useEffect(() => {
    if (!autoScan || !data || data.path !== path) return;
    setAutoScan(false);
    const fresh = data.latest && Date.now() - (data.latest.finishedAt ?? 0) < 60 * 60_000;
    if (!data.running && !fresh) void start();
  }, [autoScan, data, path, start]);

  async function cancel() {
    if (!data?.running) return;
    try {
      await api.del(`/api/storage/operations/${encodeURIComponent(data.running.id)}`);
      void mutate();
    } catch (e) {
      const m = errorText(e);
      if (m) toast.error(m);
    }
  }

  const go = (p: string) => {
    setPath(p);
    setAutoScan(true);
    setActive(null);
    setShowAll(false);
  };

  const root = rootFor(path, mounts);
  const rootLabel = mounts.find((m) => m.path === root)?.short ?? root;
  const crumbs = path === root ? [] : path.slice(root === "/" ? 1 : root.length + 1).split("/");
  const scanned = (data?.path === path ? (data?.latest?.result as UsageResult | null | undefined) : null) ?? null;
  if (scanned?.children) for (const [k, v] of Object.entries(scanned.children)) known.current.set(k, v);
  const provisional = !scanned && known.current.has(path) ? known.current.get(path)! : null;
  const result: UsageResult | null =
    scanned ??
    (provisional
      ? { path, total: provisional.entries.reduce((a, e) => a + (e.mountpoint ? 0 : e.bytes), 0) + provisional.otherBytes, entries: provisional.entries, otherBytes: provisional.otherBytes, otherCount: provisional.otherCount, unreadable: 0, filesystem: null, scannedAt: 0, durationMs: 0 }
      : null);
  const run = data?.running;
  const fsFull = result?.filesystem ? result.filesystem.used / Math.max(1, result.filesystem.size) : 0;
  const withFree = !!result?.filesystem && result.filesystem.mount === path;
  const shown = result ? result.entries.filter((e) => !e.mountpoint) : [];
  const otherDrives = result ? result.entries.filter((e) => e.mountpoint) : [];
  const max = Math.max(1, ...shown.map((e) => e.bytes));
  const denominator = result ? (withFree ? result.total + (result.filesystem?.avail ?? 0) : result.total) : 1;

  // What the readout shows: the block under the pointer, else the one worth acting on, else the biggest.
  const fallback: Block | null = React.useMemo(() => {
    if (!result) return null;
    const withHint = shown.find((e) => hintsFor(e.path, hints).length);
    const e = withHint ?? shown[0];
    return e ? { key: e.path, kind: e.dir ? "dir" : "file", name: e.name, path: e.path, bytes: e.bytes, share: e.bytes / Math.max(1, denominator), depth: 1, x: 0, y: 0, w: 0, h: 0 } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, hints.length]);
  const focus = active ?? fallback;

  return (
    <Panel
      title="What's using space"
      meta={<Select aria-label="Drive" value={root} onChange={(v) => go(v)} options={mounts.map((m) => ({ value: m.path, label: m.label }))} />}
      flush
    >
      <div className={s.usageBar}>
        <nav className={s.crumbs} aria-label="Folder">
          <button type="button" onClick={() => go(root)} disabled={path === root} title={root}>
            {rootLabel}
          </button>
          {crumbs.map((c, i) => {
            const p = `${root === "/" ? "" : root}/${crumbs.slice(0, i + 1).join("/")}`;
            return (
              <React.Fragment key={p}>
                <NavArrowRight aria-hidden className={s.crumbSep} />
                <button type="button" className="mono" onClick={() => go(p)} disabled={p === path}>
                  {c}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        <div className={s.usageActions}>
          {path !== root && (
            <IconButton label="Up one folder" size="sm" onClick={() => go(path.slice(0, path.lastIndexOf("/")) || "/")}>
              <ArrowUpLeft />
            </IconButton>
          )}
          <LinkButton href={filesHref(path)} size="sm" variant="ghost" icon={<OpenNewWindow />}>
            Open in Files
          </LinkButton>
          {run ? (
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              Stop scan
            </Button>
          ) : (
            <Button size="sm" loading={starting} onClick={() => void start()}>
              {scanned ? "Scan again" : "Scan"}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className={s.pad}>
          <Notice tone="fault" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
            {error.message}
          </Notice>
        </div>
      )}

      {run && (
        <div className={s.pad}>
          <div className={s.progress} role="progressbar" aria-label={`Measuring ${path}`} aria-valuemin={0} aria-valuemax={run.progress?.total ?? 0} aria-valuenow={run.progress?.done ?? 0}>
            <div style={{ width: `${run.progress && run.progress.total ? Math.min(100, (run.progress.done / run.progress.total) * 100) : 4}%` }} />
            <span className="num">{run.progress && run.progress.total ? `Measured ${run.progress.done} of ${run.progress.total} items in ${path}` : `Measuring ${path}…`}</span>
          </div>
          <p className={s.hint}>Large drives take a few minutes. It runs in the background at low priority, so apps aren't slowed down; you can leave this page.</p>
        </div>
      )}

      {!data && isLoading && (
        <div className={s.pad}>
          <Skeleton height={300} radius={8} />
        </div>
      )}

      {data && !result && !run && (
        <Empty title={`${path === root ? rootLabel : path} hasn't been measured yet`} action={<Button onClick={() => void start()} loading={starting}>Scan it</Button>}>
          Gluon adds up every folder inside it and draws them to scale, so the biggest ones stand out. Nothing is changed.
        </Empty>
      )}

      {result && (
        <>
          <p className={`${s.usageMeta} num`}>
            {fmt.bytes(result.total)} used in {path === root ? rootLabel : <span className="mono">{path}</span>}
            {result.filesystem && ` · ${fmt.bytes(result.filesystem.avail)} free on the drive`}
            {scanned ? (
              <>
                {" "}
                · measured <Time ts={result.scannedAt} />
              </>
            ) : (
              " · from the last scan of the folder above"
            )}
          </p>
          {shown.length === 0 && result.otherBytes === 0 ? (
            <Empty title="It's empty">There's nothing in {path}.</Empty>
          ) : (
            <div className={s.mapArea}>
              <SpaceMap result={result} withFree={withFree} hints={hints} urgent={fsFull >= 0.85} active={focus?.key ?? null} onActive={setActive} onDrill={go} />
              {focus && <Readout block={focus} hints={hintsFor(focus.path, hints)} urgent={fsFull >= 0.85} onDrill={go} />}
            </div>
          )}

          {shown.length > 0 && (
            <ul className={s.usageList} role="list" aria-label="Biggest items">
              {(showAll ? shown : shown.slice(0, LIST_N)).map((e) => (
                <li key={e.path} className={s.usageRow}>
                  <span className={s.usageName}>
                    {e.dir ? <Folder aria-hidden /> : <PageIcon aria-hidden />}
                    {e.dir ? (
                      <button type="button" className={`${s.linkish} truncate`} title={e.path} onClick={() => go(e.path)}>
                        {e.name}
                      </button>
                    ) : (
                      <span className="truncate" title={e.path}>
                        {e.name}
                      </span>
                    )}
                    {hintsFor(e.path, hints).length > 0 && <span className={s.listHint}>can be cleaned up</span>}
                  </span>
                  <span className={s.usageTrack} aria-hidden>
                    <span style={{ width: `${Math.max(0.5, (e.bytes / max) * 100)}%` }} />
                  </span>
                  <span className={`${s.usageBytes} num`}>{fmt.bytes(e.bytes)}</span>
                  <Link href={filesHref(e.path)} className={s.usageOpen} aria-label={`Open ${e.name} in Files`} title="Open in Files">
                    <OpenNewWindow aria-hidden />
                  </Link>
                </li>
              ))}
              {(showAll || shown.length <= LIST_N) && result.otherCount > 0 && (
                <li className={s.usageRow} data-other="">
                  <span className={s.usageName}>
                    <span className={s.muted}>{fmt.plural(result.otherCount, "smaller item")}</span>
                  </span>
                  <span className={s.usageTrack} aria-hidden />
                  <span className={`${s.usageBytes} num`}>{fmt.bytes(result.otherBytes)}</span>
                  <span />
                </li>
              )}
            </ul>
          )}
          {shown.length > LIST_N && (
            <div className={s.listMore}>
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show the biggest only" : `Show all ${shown.length}${result.otherCount ? ` and ${fmt.plural(result.otherCount, "smaller item")}` : ""}`}
              </Button>
            </div>
          )}
          {otherDrives.length > 0 && (
            <p className={s.usageMeta}>
              Other drives mounted inside, not counted here:{" "}
              {otherDrives.map((e, i) => (
                <React.Fragment key={e.path}>
                  {i > 0 && ", "}
                  <button type="button" className={`${s.linkish} mono`} onClick={() => go(e.path)}>
                    {e.name}
                  </button>{" "}
                  <span className="num">({fmt.bytes(e.bytes)})</span>
                </React.Fragment>
              ))}
              .
            </p>
          )}
          {result.unreadable > 0 && <p className={s.usageMeta}>{fmt.plural(result.unreadable, "item")} couldn't be read and weren't counted.</p>}
        </>
      )}
      {confirmNode}
    </Panel>
  );
}

/** The line under the map: the block in focus in words, with what you can do about it right there. */
function Readout({ block: b, hints, urgent, onDrill }: { block: Block; hints: SpaceHint[]; urgent: boolean; onDrill: (p: string) => void }) {
  const fmt = useFormat();
  const share = b.share;
  const pct = share < 0.001 ? "less than 0.1%" : `${share < 0.1 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`;
  const of = b.depth === 2 && b.parent ? ` of ${b.parent.slice(b.parent.lastIndexOf("/") + 1)}` : "";
  return (
    <div className={s.readout} aria-live="polite">
      <div className={s.readoutText}>
        <p className={s.readoutName}>
          {b.kind === "dir" ? <Folder aria-hidden /> : b.kind === "file" ? <PageIcon aria-hidden /> : null}
          <span className="truncate">{b.kind === "free" ? "Free space" : b.kind === "other" ? `${b.name} items together` : b.name}</span>
          <span className={`${s.readoutSize} num`}>
            {fmt.bytes(b.bytes)} · {pct}
            {of}
          </span>
        </p>
        {b.path && (
          <p className={`${s.readoutPath} mono truncate`} title={b.path}>
            {b.path}
          </p>
        )}
        {hints.map((h) => (
          <p key={h.path} className={s.readoutHint} data-urgent={urgent ? "" : undefined}>
            <span className={s.hintMark} aria-hidden />
            <span>
              {h.title}
              {h.bytes > 0 && <span className="num"> · {fmt.bytes(h.bytes)}</span>}
            </span>
          </p>
        ))}
      </div>
      <div className={s.readoutActions}>
        {hints.slice(0, 1).map((h) => (
          <Button key={h.path} size="sm" onClick={h.run}>
            {h.action}
          </Button>
        ))}
        {b.path && (
          <LinkButton href={filesHref(b.path)} size="sm" variant="ghost">
            Open in Files
          </LinkButton>
        )}
        {b.kind === "dir" && b.path && (
          <Button size="sm" variant="ghost" iconEnd={<NavArrowRight />} onClick={() => onDrill(b.path!)}>
            Look inside
          </Button>
        )}
      </div>
    </div>
  );
}
