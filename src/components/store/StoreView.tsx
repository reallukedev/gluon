"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "iconoir-react";
import type { AppSummary } from "@/server/docker/apps";
import { ApiError, streamPost, useApi } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { AppsSectionTabs } from "@/components/docker/AppsSectionTabs";
import { Button, LinkButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/Toast";
import { emptyStream, type StreamEvent, type StreamState } from "@/components/ui/StreamLog";
import { reduceUmbrelStream } from "@/components/apps/umbrelStream";
import { StoreGrid } from "./StoreGrid";
import { AppDialog } from "./AppDialog";
import { CategoryBar } from "./CategoryBar";
import { categoryKey, categoryName, type InstalledInfo, type StoreEntry, type StoreResponse } from "./types";
import s from "./store.module.css";

export interface InstallRun {
  state: StreamState;
  running: boolean;
}

export function StoreView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fmt = useFormat();
  const { viewer } = usePrefs();
  const { data, error, isLoading, mutate } = useApi<StoreResponse>("/api/store", { revalidateOnFocus: false });
  const { data: apps, mutate: mutateApps } = useApi<AppSummary[]>("/api/apps", { refresh: 10_000 });

  const [q, setQ] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [installedOnly, setInstalledOnly] = React.useState(false);
  const [storeId, setStoreId] = React.useState("all");
  const term = React.useDeferredValue(q.trim().toLowerCase());
  const [runs, setRuns] = React.useState<Record<string, InstallRun>>({});

  // ---------------------------------------------------------------- data

  const stores = React.useMemo(() => data?.stores ?? [], [data]);
  const entries = React.useMemo<StoreEntry[]>(() => {
    const list = stores.flatMap((store) => store.apps.map((app) => ({ key: `${store.id}:${app.id}`, app, store })));
    return list.sort((a, b) => a.app.name.localeCompare(b.app.name) || Number(b.store.official) - Number(a.store.official));
  }, [stores]);
  const byId = React.useMemo(() => {
    const m = new Map<string, StoreEntry>();
    // Official listing wins when an app is in more than one store.
    for (const e of entries) if (!m.has(e.app.id) || (e.store.official && !m.get(e.app.id)!.store.official)) m.set(e.app.id, e);
    return m;
  }, [entries]);
  const appsById = React.useMemo(() => new Map((apps ?? []).map((a) => [a.id, a])), [apps]);

  const installedInfo = React.useCallback(
    (e: StoreEntry): InstalledInfo | null => {
      const summary = appsById.get(e.app.id);
      const listed = data?.installed[e.app.id];
      if (!summary?.umbrel && !listed) return null;
      const version = summary?.umbrel?.version ?? listed?.version ?? "";
      const state = summary?.umbrel?.state ?? listed!.state;
      const latest = summary?.umbrel ? summary.umbrel.latest : version && e.app.version && version !== e.app.version ? e.app.version : null;
      const url = summary ? (viewer.zone === "home" ? (summary.urls.home ?? summary.urls.away) : (summary.urls.away ?? summary.urls.home)) : null;
      return { state, version, latest, url, progress: summary?.umbrel?.progress || null };
    },
    [appsById, data, viewer.zone],
  );

  const categories = React.useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of entries) if (storeId === "all" || e.store.id === storeId) seen.set(categoryKey(e.app.category), (seen.get(categoryKey(e.app.category)) ?? 0) + 1);
    return [...seen.entries()].map(([k, n]) => ({ value: k, label: categoryName(k), count: n })).sort((a, b) => a.label.localeCompare(b.label));
  }, [entries, storeId]);

  const visible = React.useMemo(
    () =>
      entries.filter((e) => {
        if (storeId !== "all" && e.store.id !== storeId) return false;
        if (category !== "all" && categoryKey(e.app.category) !== category) return false;
        if (installedOnly && !installedInfo(e)) return false;
        if (!term) return true;
        const a = e.app;
        return a.name.toLowerCase().includes(term) || a.id.includes(term) || a.tagline.toLowerCase().includes(term) || a.developer.toLowerCase().includes(term);
      }),
    [entries, storeId, category, term, installedOnly, installedInfo],
  );

  // ---------------------------------------------------------------- deep link (?app=<id>)

  const selectedId = params.get("app");
  const selectedStore = params.get("store");
  const selected = selectedId ? ((selectedStore && entries.find((e) => e.app.id === selectedId && e.store.id === selectedStore)) || byId.get(selectedId) || null) : null;
  const pushed = React.useRef(false);
  // Read by installs that finish later: is this page still open, and on which app?
  const selectedRef = React.useRef(selectedId);
  const alive = React.useRef(true);
  React.useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const openApp = (id: string, store?: string) => {
    const qs = new URLSearchParams({ app: id });
    // Only name the store when it isn't the listing Gluon would pick anyway.
    if (store && byId.get(id)?.store.id !== store) qs.set("store", store);
    const url = `${pathname}?${qs}`;
    if (selectedId) window.history.replaceState(null, "", url);
    else {
      window.history.pushState(null, "", url);
      pushed.current = true;
    }
  };
  const closeApp = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else window.history.replaceState(null, "", pathname);
  };

  // ---------------------------------------------------------------- install

  async function install(e: StoreEntry) {
    const id = e.app.id;
    const name = e.app.name;
    let finished: { ok: boolean; message: string } | null = null;
    const apply = (ev: StreamEvent) => {
      if (ev.type === "done") finished = { ok: ev.ok, message: ev.message };
      if (ev.type === "error") finished = { ok: false, message: ev.message };
      setRuns((r) => ({ ...r, [id]: { running: r[id]?.running ?? true, state: reduceUmbrelStream(r[id]?.state ?? emptyStream, ev) } }));
    };
    setRuns((r) => ({ ...r, [id]: { state: emptyStream, running: true } }));
    try {
      await streamPost<StreamEvent>("/api/store/install", { appId: id }, apply);
      if (!finished) apply({ type: "error", message: "Gluon lost track of the install before Umbrel finished. Umbrel may still be working on it; Apps shows where it got to." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === "reauth_cancelled"
          ? "Cancelled. Nothing was installed."
          : err instanceof Error
            ? err.message
            : "Umbrel couldn't start the install.";
      apply({ type: "error", message });
    } finally {
      setRuns((r) => ({ ...r, [id]: { ...(r[id] ?? { state: emptyStream }), running: false } }));
      void mutate();
      void mutateApps();
    }
    // Installs run on after the dialog closes or the page is left; say how it went if they've moved on.
    const result = finished as { ok: boolean; message: string } | null;
    if (result && (!alive.current || selectedRef.current !== id)) {
      if (result.ok) toast.success(`${name} is installed`, { action: { label: "Go to app", onClick: () => router.push(`/apps/${encodeURIComponent(id)}`) } });
      else toast.error(`${name} didn't install`, { description: result.message });
    }
  }

  // ---------------------------------------------------------------- render

  const clearFilters = () => {
    setQ("");
    setCategory("all");
    setStoreId("all");
    setInstalledOnly(false);
  };

  if (!data) {
    return (
      <Page>
        <PageHeader title="Apps" summary={error ? "The app store didn't load." : <Skeleton width="min(420px, 90%)" height={15} style={{ marginTop: 4 }} />} />
        <AppsSectionTabs current="store" />
        {error ? (
          <Notice tone="fault" title="Couldn't load the app store" action={<Button size="sm" loading={isLoading} onClick={() => void mutate()}>Try again</Button>}>
            {error.message} Umbrel may be busy or restarting. Try again in a minute.
          </Notice>
        ) : (
          <StoreSkeleton />
        )}
      </Page>
    );
  }

  if (data.platform !== "umbrel") {
    return (
      <Page>
        <PageHeader title="Apps" summary={data.platform === "casaos" ? "Gluon is working with CasaOS, which has its own app store." : "Gluon isn't working with Umbrel, so there's no app store here."} />
        <AppsSectionTabs current="store" />
        <Empty
          title="The app store needs Umbrel"
          action={
            <>
              <LinkButton href="/settings/server">Open Server settings</LinkButton>
              <LinkButton href="/apps" variant="ghost">
                Back to Apps
              </LinkButton>
            </>
          }
        >
          {data.platform === "casaos"
            ? "Install apps in CasaOS; they show up in Apps on their own. If Umbrel runs on this server too, choose it under Settings → Server → Works with."
            : "Gluon installs apps through Umbrel's app store. If Umbrel runs on this server, choose it under Settings → Server → Works with."}
        </Empty>
      </Page>
    );
  }

  const official = stores.filter((x) => x.official);
  const community = stores.filter((x) => !x.official);
  const from = [official.length === 1 ? `the ${official[0]!.name}` : official.length ? fmt.plural(official.length, "official store") : null, community.length ? fmt.plural(community.length, "community store") : null]
    .filter(Boolean)
    .join(" and ");
  const installedIds = new Set([...byId.keys()].filter((id) => data.installed[id] || appsById.get(id)?.umbrel));
  const updates = [...installedIds].filter((id) => installedInfo(byId.get(id)!)?.latest).length;
  const summary =
    entries.length === 0 ? (
      "Umbrel didn't list any apps."
    ) : (
      <>
        {fmt.plural(byId.size, "app")} from {from}.
        {installedIds.size > 0 && ` ${installedIds.size} installed${updates ? `, ${updates} with ${updates === 1 ? "an update" : "updates"} waiting` : ""}.`}
      </>
    );

  const filtered = !!term || category !== "all" || storeId !== "all" || installedOnly;

  return (
    <Page>
      <PageHeader title="Apps" summary={summary} />
      <AppsSectionTabs current="store" />

      {entries.length === 0 ? (
        <Empty title="No apps to show" action={<Button onClick={() => void mutate()}>Try again</Button>}>
          Umbrel may still be downloading its app store. Give it a minute, then try again.
        </Empty>
      ) : (
        <>
          <div className={s.toolbar}>
            <label className={s.filter}>
              <Search aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, purpose or developer" aria-label="Search apps" spellCheck={false} />
            </label>
            {stores.length > 1 && (
              <Select
                aria-label="Store"
                value={storeId}
                onChange={setStoreId}
                options={[{ value: "all", label: "All stores" }, ...stores.map((x) => ({ value: x.id, label: x.name, description: x.official ? undefined : "Community store" }))]}
              />
            )}
            {filtered && (
              <span className={`${s.count} num`} aria-live="polite">
                {fmt.plural(visible.length, "app")}
              </span>
            )}
          </div>
          <div className={s.body}>
          <CategoryBar
            categories={categories}
            value={category}
            onChange={setCategory}
            installedOnly={installedOnly}
            onInstalledOnly={setInstalledOnly}
            installedCount={installedIds.size}
            updates={updates}
            total={storeId === "all" ? byId.size : entries.filter((e) => e.store.id === storeId).length}
          />

          <div className={s.results}>
          {visible.length === 0 ? (
            <Empty title={term ? `Nothing matches “${q.trim()}”` : "No apps match these filters"} action={<Button onClick={clearFilters}>Clear filters</Button>}>
              {term ? "Try a shorter word, or what the app does (“photos”, “notes”)." : installedOnly ? "Nothing from this category or store is installed." : "Try another category or store."}
            </Empty>
          ) : (
            <StoreGrid entries={visible} installedInfo={installedInfo} runs={runs} onOpen={openApp} />
          )}
          </div>
          </div>
        </>
      )}

      <AppDialog
        entry={selected}
        missingId={selectedId && !selected && entries.length > 0 ? selectedId : null}
        installedInfo={installedInfo}
        runs={runs}
        byId={byId}
        isInstalled={(id) => installedIds.has(id)}
        onInstall={(e) => void install(e)}
        onOpenApp={openApp}
        onClose={closeApp}
        portUser={(port) => {
          const a = (apps ?? []).find((x) => x.line !== "stopped" && (x.webPort === port || x.containers.some((c) => c.ports.some((p) => p.host === port))));
          return a ? { id: a.id, name: a.name } : null;
        }}
      />
    </Page>
  );
}

function StoreSkeleton() {
  return (
    <>
      <div className={s.toolbar} aria-hidden>
        <Skeleton width="min(380px, 100%)" height={34} radius={8} />
        <Skeleton width={150} height={34} radius={8} />
      </div>
      <div className={s.skeletonGrid} aria-busy aria-label="Loading apps">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className={s.card} aria-hidden>
            <Skeleton width={44} height={44} radius={11} />
            <div className={s.cardText}>
              <Skeleton width="55%" height={14} />
              <Skeleton width="35%" height={12} style={{ marginTop: 6 }} />
              <Skeleton width="92%" height={12} style={{ marginTop: 12 }} />
              <Skeleton width="70%" height={12} style={{ marginTop: 6 }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
