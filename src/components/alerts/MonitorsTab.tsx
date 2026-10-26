"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { MoreHoriz, Plus, Refresh, Search, Pause, Play, EditPencil, Trash } from "iconoir-react";
import type { CheckNowResult, MonitorView } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { alertsHref } from "@/lib/settings-links";
import { MONITORS_URL, errorMessage } from "./shared";
import { monitorLine, ms, pct, Trace, TraceLegend } from "./monitorBits";
import { MonitorForm } from "./MonitorForm";
import { MonitorDetailDialog } from "./MonitorDetail";
import s from "./alerts.module.css";

type Show = "all" | "problems";
type Range = "24h" | "7d";
interface AppLite {
  id: string;
  name: string;
  icon: string | null;
}
interface Group {
  key: string;
  title: string;
  app: AppLite | null;
  monitors: MonitorView[];
  rank: number;
}

const RANGE: Record<Range, { label: string; bucketMs: number; long: string }> = {
  "24h": { label: "24 hours", bucketMs: 15 * 60_000, long: "the last 24 hours" },
  "7d": { label: "7 days", bucketMs: 3_600_000, long: "the last 7 days" },
};

const isProblem = (m: MonitorView) => m.state === "down" || m.state === "failing" || m.flapping;
function rank(m: MonitorView): number {
  return m.state === "down" ? 0 : m.state === "failing" ? 1 : m.flapping ? 2 : m.state === "pending" ? 3 : m.state === "up" ? 4 : 5;
}

/** Where a monitor looks from, in words: automatic ones are named by vantage point. */
function lane(m: MonitorView): { title: string; where: string | null; addr: string } {
  const addr = m.target.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (m.source === "auto" && m.ref?.startsWith("route:")) return { title: "From the internet", where: "from the internet", addr };
  if (m.source === "auto") return { title: "On the home network", where: "on the home network", addr };
  return { title: m.name, where: m.kind === "tcp" ? "port" : null, addr };
}

function groupsOf(monitors: MonitorView[], apps: AppLite[] | undefined): Group[] {
  const byApp = new Map((apps ?? []).map((a) => [a.id, a]));
  const map = new Map<string, Group>();
  for (const m of monitors) {
    const appId = m.config.app;
    const key = appId ?? "__own";
    let g = map.get(key);
    if (!g) {
      const app = appId ? (byApp.get(appId) ?? null) : null;
      const title = app?.name ?? (appId ? m.name.replace(/\s*\(public\)$/, "") : "Other things you watch");
      g = { key, title, app: app ?? (appId ? { id: appId, name: title, icon: null } : null), monitors: [], rank: 9 };
      map.set(key, g);
    }
    g.monitors.push(m);
    g.rank = Math.min(g.rank, rank(m));
  }
  const out = [...map.values()];
  for (const g of out) g.monitors.sort((a, b) => Number(a.source === "user") - Number(b.source === "user") || Number(!!b.ref?.startsWith("app:")) - Number(!!a.ref?.startsWith("app:")) || a.name.localeCompare(b.name));
  return out.sort((a, b) => Number(a.key === "__own") - Number(b.key === "__own") || Math.min(a.rank, 4) - Math.min(b.rank, 4) || a.title.localeCompare(b.title));
}

export function MonitorsTab({ initialOpen }: { initialOpen: string | null }) {
  const router = useRouter();
  const fmt = useFormat();
  const [range, setRange] = React.useState<Range>("24h");
  const listUrl = `${MONITORS_URL}?range=${range}`;
  const { data, error, isLoading, mutate: mutateList } = useApi<MonitorView[]>(listUrl, { refresh: 30_000, keepPreviousData: true });
  const { data: apps } = useApi<AppLite[]>("/api/apps", { revalidateOnFocus: false });
  const { mutate: globalMutate } = useSWRConfig();
  /** Refresh the list (every range) and any open detail. */
  const mutate = React.useCallback(() => {
    void mutateList();
    void globalMutate((k) => typeof k === "string" && k.startsWith(MONITORS_URL));
  }, [mutateList, globalMutate]);
  const [q, setQ] = React.useState("");
  const [show, setShow] = React.useState<Show>("all");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<string | null>(initialOpen);
  const [editing, setEditing] = React.useState<MonitorView | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  const openDetail = (id: string | null) => {
    setDetail(id);
    router.replace(alertsHref("watching", { monitor: id }), { scroll: false });
  };
  const edit = (m: MonitorView | null) => {
    setEditing(m);
    setFormOpen(true);
  };

  async function checkNow(m: MonitorView) {
    setBusy(m.id);
    try {
      const r = await api.post<CheckNowResult>(`/api/alerts/monitors/${encodeURIComponent(m.id)}/check`);
      (r.ok ? toast.success : toast.error)(`${m.name}: ${r.ok ? "answering" : "not answering"}`, { description: r.message });
      void mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function setEnabled(m: MonitorView, enabled: boolean) {
    setBusy(m.id);
    try {
      await api.patch(`/api/alerts/monitors/${encodeURIComponent(m.id)}`, { enabled });
      toast.success(enabled ? `Watching ${m.name} again` : `Paused ${m.name}`, { description: enabled ? undefined : "No checks and no alerts until you resume it." });
      void mutate();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const remove = (m: MonitorView) =>
    confirm({
      title: `Stop watching ${m.name}?`,
      consequences: ["Its check history and uptime numbers are deleted.", "Any open alert for it is closed."],
      confirmLabel: "Remove monitor",
      onConfirm: async () => {
        await api.del(`/api/alerts/monitors/${encodeURIComponent(m.id)}`);
        toast.success(`Removed ${m.name}`);
        if (detail === m.id) openDetail(null);
        void mutate();
      },
    });
  async function syncNow() {
    try {
      const r = await api.post<{ created: number; updated: number; removed: number }>("/api/alerts/monitors/sync");
      const n = r.created + r.updated + r.removed;
      toast.success(n ? `Updated automatic monitors (${r.created} new, ${r.removed} removed)` : "Automatic monitors are up to date");
      void mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const all = data ?? [];
  const term = q.trim().toLowerCase();
  const deferredTerm = React.useDeferredValue(term);
  const rows = all.filter((m) => (show === "problems" ? isProblem(m) : true)).filter((m) => !deferredTerm || m.name.toLowerCase().includes(deferredTerm) || m.target.toLowerCase().includes(deferredTerm));
  const groups = groupsOf(rows, apps);
  const problems = all.filter(isProblem).length;
  const current = all.find((m) => m.id === detail) ?? null;
  const R = RANGE[range];

  return (
    <>
      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or address" aria-label="Filter monitors" spellCheck={false} />
        </label>
        <Segmented
          aria-label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: "All" },
            { value: "problems", label: problems ? `Problems ${problems}` : "Problems" },
          ]}
        />
        <Segmented
          aria-label="History to show"
          value={range}
          onChange={setRange}
          options={[
            { value: "24h", label: "24 hours" },
            { value: "7d", label: "7 days" },
          ]}
        />
        <div className={s.toolbarEnd}>
          <Menu
            trigger={
              <IconButton label="More" variant="secondary">
                <MoreHoriz />
              </IconButton>
            }
            items={[{ label: "Look for new apps and addresses now", description: "Gluon also does this every minute", icon: <Refresh />, onSelect: () => void syncNow() }]}
          />
          <Button variant="primary" icon={<Plus />} onClick={() => edit(null)}>
            Add monitor
          </Button>
        </div>
      </div>

      {error && !data ? (
        <Notice tone="fault" title="Couldn't load monitors" action={<Button size="sm" onClick={() => void mutateList()}>Try again</Button>}>
          {error.message}
        </Notice>
      ) : isLoading && !data ? (
        <div className={s.table}>
          <div className={s.skeletons}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={s.skelRow}>
                <Skeleton height={30} width="70%" />
                <Skeleton height={30} />
                <Skeleton height={14} width={48} />
              </div>
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className={s.table}>
          <Empty
            title={term ? `Nothing matches “${q}”` : show === "problems" ? "Every monitor is answering" : "No monitors yet"}
            action={!all.length ? <Button onClick={() => edit(null)}>Add a monitor</Button> : undefined}
          >
            {all.length === 0
              ? "Gluon adds one for every app with a web page and every public address within a minute of starting. Add your own for things elsewhere on the network: a router, a NAS, a website."
              : "Try another filter."}
          </Empty>
        </div>
      ) : (
        <div className={`${s.table} ${s.monitors} appear`} role="table" aria-label={`Monitors, ${R.long}`}>
          <div className={s.headRow} role="row">
            <span role="columnheader">Checked from</span>
            <span role="columnheader">{R.label === "24 hours" ? "Last 24 hours, every 15 minutes" : "Last 7 days, by hour"}</span>
            <span role="columnheader" className={s.num}>
              Uptime
            </span>
            <span role="columnheader" className={s.num}>
              Response
            </span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {groups.map((g) => (
            <div key={g.key} role="rowgroup" className={s.group}>
              {g.monitors.length > 1 && (
              <div role="row" className={s.groupHead}>
                <span role="rowheader" className={s.groupTitle}>
                  {g.app && <AppIcon src={g.app.icon} name={g.title} size={20} />}
                  {g.app ? (
                    <Link href={`/apps/${encodeURIComponent(g.app.id)}`} className={s.groupLink} title={`Open ${g.title}`}>
                      {g.title}
                    </Link>
                  ) : (
                    <span>{g.title}</span>
                  )}
                </span>
              </div>
              )}
              {g.monitors.map((m) => (
                <MonitorRow
                  key={m.id}
                  solo={g.monitors.length === 1 && g.key !== "__own" ? g.title : null}
                  m={m}
                  range={range}
                  busy={busy === m.id}
                  onOpen={() => openDetail(m.id)}
                  onCheck={() => void checkNow(m)}
                  onEnabled={(v) => void setEnabled(m, v)}
                  onEdit={() => edit(m)}
                  onRemove={() => remove(m)}
                  since={fmt.duration}
                />
              ))}
            </div>
          ))}
          <div className={s.tableFoot}>
            <TraceLegend />
            <span className={s.muted}>Response is the time 95% of checks answered within, over the last day.</span>
          </div>
        </div>
      )}

      <MonitorDetailDialog
        id={detail}
        open={!!detail}
        onOpenChange={(o) => !o && openDetail(null)}
        footer={(d) => (
          <>
            {d.enabled ? (
              <Button variant="ghost" icon={<Pause />} onClick={() => void setEnabled(d, false)}>
                Pause
              </Button>
            ) : (
              <Button variant="ghost" icon={<Play />} onClick={() => void setEnabled(d, true)}>
                Resume
              </Button>
            )}
            <Button icon={<EditPencil />} onClick={() => edit(current ?? d)}>
              {d.source === "auto" ? "Change timing" : "Edit"}
            </Button>
            <Button variant="primary" icon={<Refresh />} loading={busy === d.id} disabled={d.state === "idle"} onClick={() => void checkNow(d)}>
              Check now
            </Button>
          </>
        )}
      />
      <MonitorForm open={formOpen} onOpenChange={setFormOpen} monitor={editing} existing={all} onSaved={() => void mutate()} />
      {confirmNode}
    </>
  );
}

function MonitorRow({
  m,
  solo,
  range,
  busy,
  onOpen,
  onCheck,
  onEnabled,
  onEdit,
  onRemove,
  since,
}: {
  m: MonitorView;
  /** Only monitor for its app: the row carries the app's name and says where it checks from. */
  solo: string | null;
  range: Range;
  busy: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onEnabled: (v: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  since: (s: number, parts?: number) => string;
}) {
  const st = monitorLine(m);
  const vantage = lane(m);
  const title = solo ?? vantage.title;
  const where = solo ? vantage.where : m.source === "user" ? vantage.where : null;
  const R = RANGE[range];
  const uptime = range === "24h" ? m.uptime.h24 : m.uptime.d7;
  const note =
    m.state === "down" || m.state === "failing"
      ? `${st.label}${m.last?.error ? `: ${m.last.error}` : ""}`
      : m.state === "up" && m.since
        ? `${st.label} for ${since(Math.max(60, (Date.now() - m.since) / 1000), 1)}`
        : st.label;
  return (
    <div
      role="row"
      className={s.row}
      data-clickable=""
      data-paused={m.state === "paused" || m.state === "idle" ? "" : undefined}
      data-problem={isProblem(m) ? "" : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,[role=menu]")) return;
        onOpen();
      }}
    >
      <span role="cell" className={s.laneCell}>
        <StateLine state={st.line} label={false} size={16} />
        <span className={s.laneText}>
          <button type="button" className={s.name} onClick={onOpen} title={`${m.name}: ${st.label}`}>
            {title}
          </button>
          <span className={s.sub} title={m.target}>
            {where && <span>{where} · </span>}
            <span className="mono">{vantage.addr}</span>
          </span>
          <span className={s.stateSub} data-fault={m.state === "down" || m.state === "failing" ? "" : undefined} title={note}>
            {note}
          </span>
        </span>
      </span>
      <span role="cell" className={s.traceCell}>
        <Trace buckets={m.strip} bucketMs={R.bucketMs} since={m.createdAt} label={`${m.name}, ${R.long}`} />
      </span>
      <span role="cell" className={`${s.num} ${s.uptime} num`} data-low={uptime !== null && uptime < 99 ? "" : undefined}>
        <span className={`label ${s.colLabel}`}>Uptime</span>
        {pct(uptime)}
      </span>
      <span role="cell" className={`${s.num} ${s.p95} num`}>
        <span className={`label ${s.colLabel}`}>Response</span>
        {ms(m.latency.p95)}
      </span>
      <span role="cell" className={s.actions}>
        <IconButton label={`Check ${m.name} now`} size="sm" loading={busy} disabled={m.state === "idle" || m.state === "paused"} onClick={onCheck}>
          <Refresh />
        </IconButton>
        <Menu
          trigger={
            <IconButton label={`${m.name} actions`} size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={[
            m.enabled
              ? { label: "Pause", description: "No checks or alerts until resumed", icon: <Pause />, onSelect: () => onEnabled(false) }
              : { label: "Resume", icon: <Play />, onSelect: () => onEnabled(true) },
            { label: m.source === "auto" ? "Change timing" : "Edit", icon: <EditPencil />, onSelect: onEdit },
            ...(m.source === "user" ? ["separator" as const, { label: "Remove", icon: <Trash />, danger: true, onSelect: onRemove }] : []),
          ]}
        />
      </span>
    </div>
  );
}
