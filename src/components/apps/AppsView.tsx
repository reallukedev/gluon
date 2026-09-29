"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHoriz, OpenNewWindow, Refresh, Play, Square, Search, Journal, Plus, EyeClosed, Eye, Pin, PinSlash } from "iconoir-react";
import { usePinToHome } from "@/components/home/pinned";
import type { AppSummary } from "@/server/docker/apps";
import type { Platform } from "@/server/platform";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty } from "@/components/ui/Surface";
import { AppsSectionTabs } from "@/components/docker/AppsSectionTabs";
import { NewAppButton } from "@/components/builder/NewAppButton";
import { StateLine } from "@/components/ui/StateLine";
import { Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { listJoin } from "@/lib/format";
import { shortName, sourceName } from "@/lib/app-names";
import { AppIcon } from "./AppIcon";
import { Addresses } from "./Addresses";
import { CpuMeter, MemMeter, useAppUsage } from "./Meters";
import { umbrelBusy } from "./umbrelStream";
import { removeCopyConfirm, stopCopyConfirm } from "./copies";
import s from "./apps.module.css";

type Filter = "all" | "problems" | "public" | "stopped";
type Sort = "name" | "cpu" | "memory";

/** Apps a person should look at: broken or stuck starting, but not ones Umbrel is busy installing or updating. */
const isProblem = (a: AppSummary) => !a.copyOf && (a.line === "unhealthy" || a.line === "starting") && !umbrelBusy(a.umbrel?.state);

export function AppsView({ initial, initialSort, initialFilter, platform }: { initial: AppSummary[]; initialSort: Sort; initialFilter: Filter; platform: Platform }) {
  const router = useRouter();
  const pinHome = usePinToHome();
  const fmt = useFormat();
  const { viewer, serverName } = usePrefs();
  const { host } = useLive();
  const { data: apps = initial, mutate } = useApi<AppSummary[]>("/api/apps", { refresh: 8000, fallbackData: initial });
  const usage = useAppUsage(apps);
  const [q, setQ] = React.useState("");
  const term = React.useDeferredValue(q.trim().toLowerCase());
  const [filter, setFilter] = React.useState<Filter>(initialFilter);
  const [sort, setSort] = React.useState<Sort>(initialSort);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const memTotal = host.at(-1)?.mem.total ?? null;
  const memScale = Math.max(0, ...[...usage.values()].map((u) => u.mem));

  const byId = new Map(apps.map((a) => [a.id, a]));
  const matches = (a: AppSummary) => {
    if (a.hidden && filter === "all" && !term) return false;
    if (filter === "problems" && !isProblem(a)) return false;
    if (filter === "stopped" && a.line !== "stopped") return false;
    if (filter === "public" && !a.routes.some((r) => r.enabled)) return false;
    return !term || a.name.toLowerCase().includes(term) || a.id.toLowerCase().includes(term) || a.containers.some((c) => c.name.includes(term) || c.image.includes(term));
  };
  const cmp = (x: AppSummary, y: AppSummary) => {
    if (sort === "cpu") return (usage.get(y.id)?.cpu ?? -1) - (usage.get(x.id)?.cpu ?? -1) || x.name.localeCompare(y.name);
    if (sort === "memory") return (usage.get(y.id)?.mem ?? -1) - (usage.get(x.id)?.mem ?? -1) || x.name.localeCompare(y.name);
    return x.name.localeCompare(y.name);
  };
  // Old copies ride directly under the app they copy, whatever the sort.
  const copiesOf = new Map<string, AppSummary[]>();
  for (const a of apps) if (a.copyOf && byId.has(a.copyOf.id)) copiesOf.set(a.copyOf.id, [...(copiesOf.get(a.copyOf.id) ?? []), a]);
  const rows: { a: AppSummary; copy: boolean }[] = [];
  for (const a of apps.filter((x) => !(x.copyOf && byId.has(x.copyOf.id))).sort(cmp)) {
    const kids = (copiesOf.get(a.id) ?? []).filter(matches);
    if (matches(a)) rows.push({ a, copy: false });
    for (const k of kids) rows.push({ a: k, copy: matches(a) });
  }

  const primaries = apps.filter((a) => !a.copyOf && !a.hidden);
  const copies = apps.filter((a) => a.copyOf && !a.hidden);
  const problems = apps.filter(isProblem);
  const stopped = primaries.filter((a) => a.line === "stopped");
  const counts = { problems: problems.length, stopped: apps.filter((a) => a.line === "stopped").length, public: apps.filter((a) => a.routes.some((r) => r.enabled)).length };
  const busyApps = apps.filter((a) => umbrelBusy(a.umbrel?.state));

  async function act(a: AppSummary, action: "start" | "stop" | "restart") {
    setBusy(a.id);
    const t = toast.loading(`${action === "restart" ? "Restarting" : action === "stop" ? "Stopping" : "Starting"} ${a.name}…`);
    try {
      const r = await api.post<{ message: string }>(`/api/apps/${encodeURIComponent(a.id)}/action`, { action });
      toast.update(t, "success", { title: r.message });
      void mutate();
    } catch (e) {
      toast.update(t, "error", { title: `Couldn't ${action} ${a.name}`, description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function setHidden(a: AppSummary, hidden: boolean) {
    try {
      await api.patch(`/api/apps/${encodeURIComponent(a.id)}/prefs`, { hidden });
      toast.info(hidden ? `${a.name} is hidden from Apps and Status` : `${a.name} shows in lists again`, {
        action: { label: "Undo", onClick: () => void api.patch(`/api/apps/${encodeURIComponent(a.id)}/prefs`, { hidden: !hidden }).then(() => mutate()) },
      });
      void mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    }
  }

  function removeCopy(a: AppSummary) {
    const of = a.copyOf ? byId.get(a.copyOf.id) : undefined;
    confirm(
      removeCopyConfirm(a, of, async () => {
        try {
          await api.post(`/api/apps/${encodeURIComponent(a.id)}/action`, { action: "down" });
        } catch (e) {
          if (e instanceof ApiError && e.code === "reauth_cancelled") return;
          throw e;
        }
        toast.success(`Removed the old ${a.name}`, { description: `${of?.name ?? a.copyOf?.name} is untouched. Its folders are still on disk.` });
        void mutate();
      }),
    );
  }

  const busyNote =
    busyApps.length === 1
      ? ` ${busyApps[0]!.name} is ${{ installing: "being installed", updating: "updating", uninstalling: "being uninstalled" }[busyApps[0]!.umbrel!.state as "installing" | "updating" | "uninstalling"]}.`
      : busyApps.length > 1
        ? ` Umbrel is working on ${busyApps.length} apps.`
        : "";
  const copyNote = copies.length ? ` ${listJoin([...new Set(copies.map((c) => c.copyOf!.name))])} ${copies.length === 1 ? "also has an old copy" : "each have an old copy"} from another installer.` : "";
  const summary = (
    <>
      {problems.length > 0 ? (
        <b>
          {listJoin(problems.map((a) => a.name))} {problems.length === 1 ? "needs" : "need"} a look.
        </b>
      ) : stopped.length === 0 ? (
        <b>{primaries.length === 1 ? "1 app, running." : `${primaries.length} apps, all running.`}</b>
      ) : (
        <b>
          {primaries.length - stopped.length} of {primaries.length} apps running.
        </b>
      )}
      {counts.public ? ` ${fmt.plural(counts.public, "app")} can be reached from the internet.` : ""}
      {copyNote}
      {busyNote}
    </>
  );

  const sortHead = (key: Sort, label: string, align?: "end") => (
    <span role="columnheader" aria-sort={sort === key ? (key === "name" ? "ascending" : "descending") : "none"} className={align ? s.headEnd : undefined}>
      <button type="button" className={s.sortButton} data-on={sort === key ? "" : undefined} onClick={() => setSort(key)}>
        {label}
      </button>
    </span>
  );

  return (
    <Page>
      <PageHeader title="Apps" summary={summary} />
      <AppsSectionTabs current="apps" />

      {/* The table sizes its columns to this box, not the window, so the sidebar can't push it off the edge. */}
      <div className={s.list}>
      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, container or image" aria-label="Filter apps" spellCheck={false} />
        </label>
        <Segmented
          aria-label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "problems", label: counts.problems ? `Problems ${counts.problems}` : "Problems" },
            { value: "public", label: "Public" },
            { value: "stopped", label: "Stopped" },
          ]}
        />
        <span className={s.sortSelect}>
          <Select
            aria-label="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: "name", label: "Sort by name" },
              { value: "cpu", label: "Sort by CPU" },
              { value: "memory", label: "Sort by memory" },
            ]}
          />
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty
          title={term ? `Nothing matches “${q.trim()}”` : filter === "problems" ? "No problems" : filter === "stopped" ? "Nothing is stopped" : filter === "public" ? "Nothing is public" : "No apps yet"}
          action={
            !term && filter === "all" ? (
              <>
                {platform === "umbrel" && (
                  <LinkButton href="/apps/store" variant="primary" icon={<Plus />}>
                    Open the app store
                  </LinkButton>
                )}
                <NewAppButton variant={platform === "umbrel" ? "secondary" : "primary"} />
              </>
            ) : (
              <Button
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                Show all apps
              </Button>
            )
          }
        >
          {term
            ? "Try the app's name, a container name or its image."
            : filter === "problems"
              ? "Every app is running and healthy."
              : filter === "stopped"
                ? "Every app is running."
                : filter === "public"
                  ? "No app is reachable from the internet. Publish one from Network → Public addresses."
                  : platform === "umbrel"
                    ? "Nothing is running on this server yet. Get an app from the app store, or start a Compose stack."
                    : "Nothing is running on this server yet. Install one from CasaOS or start a Compose stack."}
        </Empty>
      ) : (
        <div className={s.table} role="table" aria-label="Apps" aria-rowcount={rows.length + 1}>
          <div className={s.headRow} role="row">
            {sortHead("name", "App")}
            <span role="columnheader">State</span>
            {sortHead("cpu", "CPU", "end")}
            {sortHead("memory", "Memory", "end")}
            <span role="columnheader">Addresses</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {rows.map(({ a, copy }) => {
            const href = `/apps/${encodeURIComponent(a.id)}`;
            const busyState = umbrelBusy(a.umbrel?.state);
            const u = usage.get(a.id);
            const open = viewer.zone === "home" ? (a.urls.home ?? a.urls.away) : (a.urls.away ?? a.urls.home);
            const running = a.line !== "stopped";
            const menu: MenuEntry[] = [
              { label: "Restart", icon: <Refresh />, onSelect: () => void act(a, "restart"), disabled: !running || busyState },
              running
                ? { label: "Stop", icon: <Square />, onSelect: () => void act(a, "stop"), disabled: a.self || busyState }
                : { label: "Start", icon: <Play />, onSelect: () => void act(a, "start"), disabled: busyState },
              "separator",
              { label: "Logs", icon: <Journal />, onSelect: () => router.push(`${href}?tab=logs`) },
              ...(open || a.urls.home || a.urls.away
                ? [
                    pinHome.isPinned(a.id)
                      ? { label: "Unpin from Home", icon: <PinSlash />, onSelect: () => void pinHome.toggle(a) }
                      : { label: "Pin to Home", icon: <Pin />, description: "Keep it on your Home page", onSelect: () => void pinHome.toggle(a) },
                  ]
                : []),
              a.hidden
                ? { label: "Show in lists", icon: <Eye />, onSelect: () => void setHidden(a, false) }
                : { label: "Hide from lists", icon: <EyeClosed />, description: "It keeps running", onSelect: () => void setHidden(a, true) },
            ];
            return (
              <div
                key={a.id}
                role="row"
                className={s.row}
                data-copy={a.copyOf ? "" : undefined}
                data-nested={copy ? "" : undefined}
                data-hidden={a.hidden ? "" : undefined}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button,[role=menu]")) return;
                  router.push(href);
                }}
              >
                <span role="cell" className={s.appCell}>
                  <AppIcon src={a.icon} name={a.name} size={34} />
                  <span className={s.appText}>
                    <Link href={href} className={s.appName} title={a.name}>
                      {shortName(a.name, serverName)}
                    </Link>
                    <span className={s.appSub}>
                      {a.copyOf ? (
                        <>Old copy from {sourceName(a.source)}</>
                      ) : (
                        <>
                          {sourceName(a.source)}
                          {a.containers.length > 1 && ` · ${a.containers.length} containers`}
                        </>
                      )}
                      {a.self && " · this is Gluon"}
                      {a.hidden && " · hidden"}
                    </span>
                  </span>
                </span>
                <span role="cell" className={s.stateCell}>
                  {busyState ? (
                    <UmbrelProgress app={a} />
                  ) : (
                    <StateLine state={a.line} label={a.copyOf ? (running ? "Old copy, still running" : "Old copy, stopped") : a.summary} />
                  )}
                  {a.umbrel?.latest && !busyState && !a.self && (
                    <span className={s.update} title={`${a.umbrel.version} is installed; ${a.umbrel.latest} is available`}>
                      <StateLine state="attention" size={11} label={`Update to ${a.umbrel.latest}`} />
                    </span>
                  )}
                </span>
                <span role="cell" className={s.meterCell}>
                  <CpuMeter series={u?.cpuSeries ?? null} value={u?.cpu ?? null} name={a.name} fit />
                </span>
                <span role="cell" className={s.meterCell}>
                  <MemMeter value={u?.mem ?? null} scale={memScale} total={memTotal} name={a.name} fit />
                </span>
                <span role="cell" className={s.addrCell}>
                  {a.copyOf ? (
                    <CopyNote app={a} of={byId.get(a.copyOf.id)} onRemove={() => removeCopy(a)} onStop={() => confirm(stopCopyConfirm(a, byId.get(a.copyOf!.id), () => act(a, "stop")))} onHide={() => void setHidden(a, true)} />
                  ) : (
                    <Addresses app={a} empty={busyState && a.containers.length === 0 ? "Not ready yet" : "No web page"} />
                  )}
                </span>
                <span role="cell" className={s.actions}>
                  {open && !a.copyOf && (
                    <IconButton label={`Open ${a.name}`} size="sm" onClick={() => window.open(open, "_blank", "noopener")}>
                      <OpenNewWindow />
                    </IconButton>
                  )}
                  <Menu
                    trigger={
                      <IconButton label={`${a.name} actions`} size="sm" loading={busy === a.id} disabled={busyState && a.containers.length === 0}>
                        <MoreHoriz />
                      </IconButton>
                    }
                    items={menu}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
      </div>
      {confirmNode}
    </Page>
  );
}

/** Umbrel installing / updating / removing, with its real percentage when Umbrel gives one. */
function UmbrelProgress({ app }: { app: AppSummary }) {
  const u = app.umbrel!;
  const verb = { installing: "Installing", updating: "Updating", uninstalling: "Removing" }[u.state as "installing" | "updating" | "uninstalling"];
  return (
    <span className={s.progress}>
      <StateLine state="starting" label={u.progress ? `${verb} · ${u.progress}%` : `${verb}…`} />
      <span className={s.progressTrack} role="progressbar" aria-label={`${verb} ${app.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.progress || undefined}>
        <span style={{ transform: `scaleX(${(u.progress || 0) / 100})` }} data-indeterminate={u.progress ? undefined : ""} />
      </span>
    </span>
  );
}

/** What an old copy is, and the one thing to do about it. */
function CopyNote({ app, of, onRemove, onStop, onHide }: { app: AppSummary; of: AppSummary | undefined; onRemove: () => void; onStop: () => void; onHide: () => void }) {
  const running = app.line !== "stopped";
  const name = of?.name ?? app.copyOf!.name;
  const canRemove = !!app.configFile && !app.self;
  return (
    <span className={s.copyNote}>
      <span className={s.copyText}>
        {of?.line !== "stopped" ? `${name} from ${sourceName(app.copyOf!.source)} is the one in use.` : `${name} from ${sourceName(app.copyOf!.source)} replaces it.`}
      </span>
      {canRemove ? (
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {running ? "Stop and remove…" : "Remove…"}
        </Button>
      ) : running ? (
        <Button size="sm" variant="ghost" onClick={onStop}>
          Stop it
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={onHide}>
          Hide it
        </Button>
      )}
    </span>
  );
}
