"use client";
// Server widgets for admins' Home: uptime of watched addresses, recent activity, drive health and
// the busiest apps. Each reads an existing admin API, so members never see them in the catalog.
import * as React from "react";
import Link from "next/link";
import { registerWidget } from "../widgetStore";
import type { SettingsProps, WidgetProps } from "../types";
import type { MonitorView } from "@/lib/alerts-types";
import type { ActivityPage } from "@/lib/people-types";
import type { DiskView, Inventory } from "@/lib/storage-types";
import type { StatusPayload } from "@/server/status";
import type { LineState } from "@/lib/types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Field, Segmented } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { monitorLine, pct, Trace } from "@/components/alerts/monitorBits";
import { AppIcon } from "@/components/apps/AppIcon";
import { useAppUsage } from "@/components/apps/Meters";
import { WidgetState, useFit } from "./kit";
import { activityHref, alertsHref } from "@/lib/settings-links";
import { Preview } from "../previews";
import w from "./watch.module.css";

// ---------------------------------------------------------------- shared bits

function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className={w.body}>
      <Skeleton width="55%" height={18} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${80 - i * 8}%`} height={12} />
      ))}
    </div>
  );
}

function Failed({ title, status, retry }: { title: string; status?: number; retry?: () => void }) {
  return (
    <WidgetState
      line={status === 403 ? undefined : "unknown"}
      title={title}
      action={
        retry && status !== 403 ? (
          <button type="button" className={w.retry} onClick={retry}>
            Try again
          </button>
        ) : undefined
      }
    >
      {status === 403 ? "Only admins can see this." : "Gluon couldn't load it just now. It tries again on its own."}
    </WidgetState>
  );
}

const QUARTER = 15 * 60_000;

// ---------------------------------------------------------------- uptime

function UptimeWidget({ size }: WidgetProps) {
  const { data, error, mutate } = useApi<MonitorView[]>("/api/alerts/monitors?range=24h", { refresh: 60_000 });
  const watched = (data ?? []).filter((m) => m.enabled && m.state !== "idle");
  const [listRef, fit] = useFit<HTMLUListElement>(size === "s" ? 0 : watched.length);
  if (!data) return error ? <Failed title="Can't show uptime" status={error.status} retry={() => void mutate()} /> : <Loading />;

  if (!watched.length) {
    return (
      <div className={w.body}>
        <p className={w.headline}>
          <StateLine state="stopped" label={false} size={18} />
          <span>Nothing is being watched</span>
        </p>
        <p className={w.subWrap}>Gluon checks your apps and public addresses once they're added in Settings → Alerts.</p>
        <Link href={alertsHref()} className={w.more}>
          Watch an address
        </Link>
      </div>
    );
  }

  const down = watched.filter((m) => m.state === "down" || m.state === "failing");
  const order = (m: MonitorView) => (m.state === "down" ? 0 : m.state === "failing" ? 1 : m.flapping ? 2 : 3);
  const list = [...watched].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const wide = size === "w" || size === "x";
  const max = size === "s" ? 0 : watched.length;
  const traces = size === "l" || wide;
  const hidden = size === "s" ? 0 : watched.length - fit;

  return (
    <div className={w.body}>
      <p className={w.headline}>
        <StateLine state={down.length ? "unhealthy" : "running"} label={false} size={18} />
        <span>
          {down.length ? (
            <>
              <span className="num">{down.length}</span> of <span className="num">{watched.length}</span> not answering
            </>
          ) : (
            <>{watched.length === 1 ? `${watched[0]!.name} is answering` : <>All <span className="num">{watched.length}</span> answering</>}</>
          )}
        </span>
      </p>
      <p className={w.sub}>{down.length ? down.map((m) => m.name).join(", ") : "Checked every minute from this server"}</p>
      {max > 0 && (
        <ul className={wide ? w.cells : w.list} role="list" ref={listRef}>
          {list.map((m, i) => {
            const st = monitorLine(m);
            return (
              <li key={m.id} className={wide ? w.cell : w.row} data-trace={traces ? "" : undefined} aria-hidden={i >= fit || undefined}>
                <StateLine state={st.line} label={false} size={12} />
                <span className={w.rowText}>
                  <span className={w.rowSplit}>
                    <span className={w.rowTitle} title={m.name}>
                      {m.name}
                    </span>
                    <span className={`${w.rowFig} num`} title="Uptime, last 24 hours">
                      {pct(m.uptime.h24)}
                    </span>
                  </span>
                  {traces ? (
                    <Trace buckets={m.strip} bucketMs={QUARTER} since={m.createdAt} label={`${m.name}, last 24 hours`} latency={false} />
                  ) : (
                    st.line !== "running" && <span className={w.rowMeta}>{st.label}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {size !== "s" && (
        <Link href={alertsHref()} className={w.more}>
          {hidden > 0 ? `${hidden} more in Alerts` : "Open Alerts"}
        </Link>
      )}
    </div>
  );
}

registerWidget({
  type: "server.uptime",
  name: "Uptime",
  description: "Whether your apps and public addresses answer, with the last 24 hours in bigger sizes.",
  category: "Server",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "t",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Uptime",
  Component: UptimeWidget,
  preview: <Preview of="uptime" />,
});

// ---------------------------------------------------------------- activity

function ActivityWidget({ size }: WidgetProps) {
  const limit = size === "s" ? 1 : size === "m" ? 3 : size === "t" || size === "w" ? 5 : 9;
  const { data, error, mutate } = useApi<ActivityPage>(`/api/activity?limit=${limit}`, { refresh: 30_000 });
  if (!data) return error ? <Failed title="Can't show activity" status={error.status} retry={() => void mutate()} /> : <Loading rows={Math.min(limit, 4)} />;
  if (!data.items.length) {
    return <WidgetState title="Nothing yet">Changes people make and things the server notices appear here.</WidgetState>;
  }
  return (
    <div className={w.body}>
      <ul className={w.list} role="list" data-flush="">
        {data.items.map((e) => (
          <li key={e.id} className={w.row} data-failed={e.outcome === "failed" ? "" : undefined}>
            <StateLine state={e.outcome === "failed" ? "unhealthy" : e.kind === "system" ? "stopped" : "running"} label={false} size={12} />
            <span className={w.rowText}>
              <span className={w.rowTitle} title={e.summary}>
                {e.kind === "user" && e.username ? <b>{e.username} </b> : null}
                {e.kind === "user" && e.username ? e.summary.charAt(0).toLowerCase() + e.summary.slice(1) : e.summary}
              </span>
              <span className={w.rowMeta}>
                <Time ts={e.at} />
              </span>
            </span>
          </li>
        ))}
      </ul>
      {size !== "s" && (
        <Link href={activityHref()} className={w.more}>
          All activity
        </Link>
      )}
    </div>
  );
}

registerWidget({
  type: "server.activity",
  name: "Recent activity",
  description: "Who changed what on the server, and what the server noticed on its own.",
  category: "Server",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "t",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Recent activity",
  Component: ActivityWidget,
  preview: <Preview of="activity" />,
});

// ---------------------------------------------------------------- drive health

function driveState(d: DiskView): { line: LineState; word: string } {
  const sm = d.smart;
  if (!sm) return { line: "unknown", word: "No health data" };
  switch (sm.state) {
    case "failing":
      return { line: "unhealthy", word: "Failing" };
    case "warning":
      return { line: "attention", word: sm.notes[0] ?? "Worth a look" };
    case "asleep":
      return { line: "stopped", word: "Asleep" };
    case "unavailable":
      return { line: "unknown", word: "Can't read its health" };
    case "ok":
      if (sm.temperature !== null && sm.tempLimit !== null && sm.temperature >= sm.tempLimit) return { line: "attention", word: "Running hot" };
      return { line: "running", word: "Healthy" };
    default:
      return { line: "unknown", word: "Unknown" };
  }
}

function DrivesWidget({ size }: WidgetProps) {
  const fmt = useFormat();
  const { data, error, mutate } = useApi<Inventory>("/api/storage", { refresh: 120_000 });
  const disks = (data?.disks ?? []).filter((d) => d.mediaPresent && d.size > 0 && !d.removable);
  const [listRef, fit] = useFit<HTMLUListElement>(size === "s" ? 0 : disks.length);
  if (!data) return error ? <Failed title="Can't show drives" status={error.status} retry={() => void mutate()} /> : <Loading />;
  if (!disks.length) return <WidgetState title="No drives found">Gluon didn&apos;t find any fixed drives on this machine.</WidgetState>;
  const states = disks.map((d) => ({ d, ...driveState(d) }));
  const bad = states.filter((x) => x.line === "unhealthy");
  const look = states.filter((x) => x.line === "attention");
  const order = (x: { line: LineState }) => (x.line === "unhealthy" ? 0 : x.line === "attention" ? 1 : 2);
  const max = size === "s" ? 0 : disks.length;
  const hidden = size === "s" ? 0 : disks.length - fit;
  return (
    <div className={w.body}>
      <p className={w.headline}>
        <StateLine state={bad.length ? "unhealthy" : look.length ? "attention" : "running"} label={false} size={18} />
        <span>
          {bad.length
            ? `${fmt.plural(bad.length, "drive is", "drives are")} failing`
            : look.length
              ? `${fmt.plural(look.length, "drive needs", "drives need")} a look`
              : disks.length === 1
                ? "The drive is healthy"
                : `All ${disks.length} drives are healthy`}
        </span>
      </p>
      {size === "s" && <p className={w.sub}>{[...bad, ...look].map((x) => x.d.title).join(", ") || "Checked every 30 minutes"}</p>}
      {max > 0 && (
        <ul className={w.list} role="list" ref={listRef}>
          {[...states].sort((a, b) => order(a) - order(b) || b.d.size - a.d.size).map((x, i) => (
            <li key={x.d.id} className={w.row} aria-hidden={i >= fit || undefined}>
              <StateLine state={x.line} label={false} size={12} />
              <span className={w.rowText}>
                <span className={w.rowSplit}>
                  <span className={w.rowTitle} title={x.d.model ?? x.d.title}>
                    {x.d.title}
                  </span>
                  {x.d.smart?.temperature !== null && x.d.smart?.temperature !== undefined && x.d.smart.state !== "asleep" && (
                    <span className={`${w.rowFig} num`}>{fmt.temp(x.d.smart.temperature)}</span>
                  )}
                </span>
                <span className={w.rowMeta} title={x.word}>
                  {x.word}
                  {x.d.smart?.powerOnHours ? ` · ${fmt.duration(x.d.smart.powerOnHours * 3600, 1)} powered on` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {size !== "s" && (
        <Link href="/storage" className={w.more}>
          {hidden > 0 ? `${hidden} more in Storage` : "Open Storage"}
        </Link>
      )}
    </div>
  );
}

registerWidget({
  type: "server.drives",
  name: "Drive health",
  description: "Each drive's health and temperature, read from the drives themselves.",
  category: "Server",
  sizes: ["s", "m", "t", "l"],
  defaultSize: "m",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Drives",
  Component: DrivesWidget,
  preview: <Preview of="drives" />,
});

// ---------------------------------------------------------------- busiest apps

interface BusyConfig {
  by?: "cpu" | "memory";
}

function BusyWidget({ item, size }: WidgetProps<BusyConfig>) {
  const fmt = useFormat();
  const by = item.config.by ?? "memory";
  const { data, error, mutate } = useApi<StatusPayload>("/api/status", { refresh: 30_000 });
  const apps = React.useMemo(() => (data?.apps ?? []).filter((a) => a.line !== "stopped"), [data]);
  const usage = useAppUsage(apps);
  const { host, status } = useLive();
  const ranked = apps
    .map((a) => ({ a, u: usage.get(a.id) }))
    .filter((x): x is { a: (typeof apps)[number]; u: NonNullable<typeof x.u> } => !!x.u)
    .sort((x, y) => (by === "cpu" ? y.u.cpu - x.u.cpu : y.u.mem - x.u.mem))
    .slice(0, 12);
  // Rows that don't fit whole are hidden (never half a row cut off at the bottom of the tile).
  const [listRef, fit] = useFit<HTMLUListElement>(ranked.length);
  if (!data) return error ? <Failed title="Can't show apps" status={error.status} retry={() => void mutate()} /> : <Loading />;
  if (!apps.length) return <WidgetState title="Nothing is running">Apps appear here, busiest first, once they&apos;re started.</WidgetState>;
  if (!usage.size) {
    if (status === "offline") return <Failed title="Live readings stopped" />;
    return <Loading />;
  }
  const top = ranked[0] ? (by === "cpu" ? ranked[0].u.cpu : ranked[0].u.mem) : 0;
  const total = host.at(-1)?.mem.total ?? null;
  return (
    <div className={w.body}>
      <ul className={w.list} role="list" data-flush="" ref={listRef}>
        {ranked.map(({ a, u }, i) => {
          const v = by === "cpu" ? u.cpu : u.mem;
          return (
            <li key={a.id} className={w.appRow} aria-hidden={i >= fit || undefined}>
              <AppIcon src={a.icon} name={a.name} size={24} />
              <Link href={`/apps/${encodeURIComponent(a.id)}`} className={w.appName} title={a.name} tabIndex={i >= fit ? -1 : undefined}>
                {a.name}
              </Link>
              <span className={`${w.rowFig} num`} title={by === "memory" && total ? `${fmt.percent((u.mem / total) * 100, 1)} of this server's memory` : undefined}>
                {by === "cpu" ? fmt.percent(u.cpu, 1) : fmt.bytes(u.mem)}
              </span>
              <span className={w.bar} aria-hidden>
                <span style={{ transform: `scaleX(${top > 0 ? Math.max(0.02, v / top) : 0})` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {size !== "s" && (
        <Link href={`/apps?sort=${by === "cpu" ? "cpu" : "memory"}`} className={w.more}>
          All apps by {by === "cpu" ? "processor" : "memory"}
        </Link>
      )}
    </div>
  );
}

function BusySettings({ config, onChange }: SettingsProps<BusyConfig>) {
  return (
    <Field label="Rank by">
      <Segmented
        aria-label="Rank by"
        value={config.by ?? "memory"}
        onChange={(v) => onChange({ ...config, by: v })}
        options={[
          { value: "memory", label: "Memory" },
          { value: "cpu", label: "Processor" },
        ] as const}
      />
    </Field>
  );
}

registerWidget<BusyConfig>({
  type: "server.busy",
  name: "Busiest apps",
  description: "The apps using the most memory or processor right now.",
  category: "Server",
  sizes: ["s", "m", "t", "l"],
  defaultSize: "m",
  defaultConfig: { by: "memory" },
  adminOnly: true,
  title: (c: BusyConfig) => ((c.by ?? "memory") === "cpu" ? "Busiest apps" : "Biggest apps"),
  Component: BusyWidget,
  Settings: BusySettings,
  preview: <Preview of="busy" />,
});
