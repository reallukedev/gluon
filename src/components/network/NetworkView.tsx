"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, MoreHoriz, ClockRotateRight, Code, Refresh, Link as LinkIcon, ChatBubble } from "iconoir-react";
import type { ExposureReport, NetworkStatus, RouteT, RoutesConfigT, RoutesResponse, RoutesSaveResponse } from "@/lib/network-types";
import { api, ApiError } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { prefersReducedMotion } from "@/lib/client/motion";
import { useRoutes, useNetStatus, useExposure, useDdns, useAppList, saveRoutes, bare } from "./shared";
import { buildEntries, entryFor, dnsHop, routerHop, caddyHop, appsHop, type Address, type AppEntry, type HopId } from "./model";
import { NetworkMap, type MapModel } from "./NetworkMap";
import { DnsDetails, RouterDetails, CaddyDetails } from "./HopDetails";
import { AppList } from "./AppList";
import { AppDetails } from "./AppDetails";
import { HomeReach } from "./HomeReach";
import { PublishFlow, type FlowTarget } from "./PublishFlow";
import { ChatServerFlow, type ChatTarget } from "./ChatServerFlow";
import { HostRedirectFlow, type HostRedirectTarget } from "./HostRedirectFlow";
import { HistoryDialog } from "./HistoryDialog";
import { CaddyfileDialog } from "./CaddyfileDialog";
import { driftSentence } from "./DriftNotice";
import s from "./network.module.css";

export type Landing = { kind: "publish"; appId: string } | { kind: "route"; id: string } | { kind: "hop"; hop: HopId } | { kind: "list" };

export interface Commit {
  (routes: RouteT[], opts?: { fallback?: RoutesConfigT["fallback"]; quiet?: boolean; success?: string }): Promise<RoutesSaveResponse>;
}

const HOP_TITLE: Record<Exclude<HopId, "apps">, string> = {
  dns: "Cloudflare DNS",
  router: "Your router and internet address",
  caddy: "Web server (Caddy) and certificates",
};

export function NetworkView({ initial, landing }: { initial: RoutesResponse | null; landing: Landing | null }) {
  const router = useRouter();
  const { serverName } = usePrefs();
  const routes = useRoutes(initial);
  const status = useNetStatus();
  const exposure = useExposure();
  const ddns = useDdns();
  const apps = useAppList();
  const [confirm, confirmNode] = useConfirm();

  const [hop, setHop] = React.useState<HopId | null>(landing?.kind === "hop" ? landing.hop : null);
  const [detailsKey, setDetailsKey] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [flow, setFlow] = React.useState<FlowTarget | null>(landing?.kind === "publish" ? { mode: "new", appId: landing.appId } : null);
  const [chat, setChat] = React.useState<ChatTarget | null>(null);
  const [hostRedirect, setHostRedirect] = React.useState<HostRedirectTarget | null>(null);
  const [history, setHistory] = React.useState(false);
  const [caddyfile, setCaddyfile] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [refreshingExposure, setRefreshingExposure] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [highlight, setHighlight] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLElement>(null);
  const mapRef = React.useRef<HTMLDivElement>(null);
  const detailsId = React.useId();

  const data = routes.data;
  const entries = React.useMemo(() => (data ? buildEntries(data, status.data, exposure.data, apps.data) : null), [data, status.data, exposure.data, apps.data]);
  const entry = detailsKey && entries ? entries.find((e) => e.key === detailsKey) : undefined;

  // ---- deep links: act once, then drop the query so a reload doesn't reopen anything.
  const landed = React.useRef(false);
  React.useEffect(() => {
    if (landed.current || !landing) return;
    if (landing.kind === "route" && !entries) return;
    landed.current = true;
    if (landing.kind === "route" && entries) {
      const e = entryFor(entries, landing.id);
      if (e) {
        setDetailsKey(e.key);
        setDetailsOpen(true);
        setHighlight(e.key);
      }
    } else if (landing.kind === "list") {
      requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "start" }));
    } else if (landing.kind === "hop") {
      requestAnimationFrame(() => mapRef.current?.scrollIntoView({ block: "start" }));
    }
    router.replace("/network", { scroll: false });
  }, [landing, entries, router]);

  const commit: Commit = React.useCallback(
    async (next, opts = {}) => {
      const cur = routes.data;
      if (!cur) throw new Error("The addresses haven't loaded yet.");
      try {
        const res = await saveRoutes(cur.rev, next, opts.fallback);
        await routes.mutate({ ...cur, ...res, driftInfo: null, caddyRunning: true }, { revalidate: true });
        void status.mutate();
        void exposure.mutate();
        const fresh = res.warnings.filter((w) => w.isNew);
        if (!opts.quiet) toast.success(opts.success ?? "Saved. The web server is using the new addresses.");
        for (const w of fresh) toast.attention("Reachable without a login", { description: w.message, timeout: 12_000 });
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.code === "stale") {
          toast.error("The addresses changed somewhere else", {
            description: "Reload to see the latest, then make your change again.",
            action: { label: "Reload", onClick: () => void routes.mutate() },
          });
        }
        throw e;
      }
    },
    [routes, status, exposure],
  );

  async function recheck() {
    setChecking(true);
    try {
      const [fresh] = await Promise.all([api.get<NetworkStatus>("/api/network/status?refresh=1"), ddns.mutate()]);
      await status.mutate(fresh, { revalidate: false });
      toast.success("Checked every address just now.");
    } catch (e) {
      toast.error("Couldn't run the checks", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setChecking(false);
    }
  }

  async function refreshExposure(quiet = false) {
    setRefreshingExposure(true);
    try {
      const fresh = await api.get<ExposureReport>("/api/network/exposure?refresh=1");
      await exposure.mutate(fresh, { revalidate: false });
      if (!quiet) toast.success("Checked again just now.");
    } catch (e) {
      if (!quiet) toast.error("Couldn't check", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setRefreshingExposure(false);
    }
  }

  // ---- actions on the picture
  const failed = (what: string) => (e: unknown) => {
    if (!(e instanceof ApiError && e.code === "stale")) toast.error(what, { description: e instanceof Error ? e.message : undefined });
  };

  async function setEnabled(key: string, ids: Set<string>, on: boolean, label: string) {
    if (!data) return;
    const before = data.config.routes;
    setBusy(key);
    try {
      await commit(
        before.map((r) => (ids.has(r.id) ? { ...r, enabled: on } : r)),
        { quiet: true },
      );
      toast.success(on ? `${label} is on the internet again` : `${label} is off the internet`, {
        description: on ? undefined : "It keeps working at home. Its settings are kept.",
        action: { label: "Undo", onClick: () => void commit(before, { success: "Undone." }).catch(failed("Couldn't undo")) },
      });
    } catch (e) {
      failed(`Couldn't turn ${on ? "on" : "off"} ${label}`)(e);
    } finally {
      setBusy(null);
    }
  }

  const idsOf = (e: AppEntry) => new Set([e.main, ...e.also].filter((a) => a.route).map((a) => a.id));
  const toggleEntry = (e: AppEntry, on: boolean) => void setEnabled(e.key, idsOf(e), on, e.name);
  const toggleAddress = (a: Address, on: boolean) => {
    const owner = entries ? entryFor(entries, a.id) : undefined;
    void setEnabled(owner?.key ?? a.id, new Set([a.id]), on, bare(a.url));
  };

  function homeOnly(e: AppEntry) {
    const addrs = [e.main, ...e.also].filter((a) => a.enabled && a.route);
    confirm({
      title: `Make ${e.name} home-only?`,
      consequences: [
        `${addrs.map((a) => bare(a.url)).join(", ")} ${addrs.length === 1 ? "stops" : "stop"} answering visitors from the internet.`,
        `At home, ${e.name} keeps working at its usual address.`,
        "Its settings are kept, so you can turn it back on here.",
      ],
      confirmLabel: "Make it home-only",
      variant: "primary",
      onConfirm: async () => {
        if (!data) return;
        const ids = idsOf(e);
        setBusy(e.key);
        try {
          await commit(
            data.config.routes.map((r) => (ids.has(r.id) ? { ...r, enabled: false } : r)),
            { success: `${e.name} is home-only now.` },
          );
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function removeIds(title: string, ids: Set<string>, consequences: string[], success: string, after?: () => void) {
    confirm({
      title,
      consequences: [...consequences, "The app keeps running and stays reachable at home.", "You can bring it back from History."],
      confirmLabel: "Remove",
      onConfirm: async () => {
        if (!data) return;
        await commit(
          data.config.routes.filter((r) => !ids.has(r.id)),
          { success },
        );
        after?.();
      },
    });
  }

  function removeAddress(a: Address) {
    if (!data || !a.route) return;
    const ids = new Set([a.id]);
    const extra: string[] = [];
    // Removing a subdomain also removes the short links that lead to it.
    if (a.route.type === "subdomain") {
      const host = a.route.host;
      for (const r of data.config.routes) if (r.type === "redirect" && r.target.replace(/^https?:\/\//, "").split(/[/:]/)[0]?.toLowerCase() === host) ids.add(r.id);
      if (ids.size > 1) extra.push(`Its short link${ids.size > 2 ? "s" : ""} ${[...ids].filter((x) => x !== a.id).map((x) => bare(data.urls[x] ?? "")).join(", ")} ${ids.size > 2 ? "go" : "goes"} too.`);
    }
    const owner = entries ? entryFor(entries, a.id) : undefined;
    const closes = owner && owner.main.id === a.id && owner.also.every((x) => ids.has(x.id));
    removeIds(`Remove ${bare(a.url)}?`, ids, [`${bare(a.url)} stops working for everyone on the internet right away.`, ...extra], `Removed ${bare(a.url)}.`, closes ? () => setDetailsOpen(false) : undefined);
  }

  function removeApp(e: AppEntry) {
    const ids = idsOf(e);
    removeIds(
      `Take ${e.name} off the internet?`,
      ids,
      [`${[e.main, ...e.also].filter((a) => a.route).map((a) => bare(a.url)).join(", ")} ${ids.size === 1 ? "stops" : "stop"} working for everyone on the internet right away.`],
      `${e.name} is off the internet.`,
      () => setDetailsOpen(false),
    );
  }

  async function markLogin(e: AppEntry, v: "yes" | "no") {
    if (!e.appId) return;
    setBusy(e.key);
    try {
      await api.patch(`/api/apps/${encodeURIComponent(e.appId)}/prefs`, { hasLogin: v });
      toast.success(v === "yes" ? `Noted: ${e.name} has its own login` : `Noted: ${e.name} has no login`);
      void apps.mutate();
      void routes.mutate();
      await refreshExposure(true);
    } catch (err) {
      toast.error("Couldn't save that", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  const openEntry = (e: AppEntry) => {
    setDetailsKey(e.key);
    setDetailsOpen(true);
  };
  const editRoute = (id: string) => {
    const r = data?.config.routes.find((x) => x.id === id);
    setDetailsOpen(false);
    if (r?.type === "subdomain" && r.redirect_to) setHostRedirect({ mode: "edit", id });
    else if (r?.type === "subdomain" && r.xmpp) setChat({ mode: "edit", id });
    else setFlow(r?.type === "redirect" ? { mode: "redirect", id } : { mode: "edit", id });
  };

  // ---- the header sentence: state first.
  let summary: React.ReactNode = "Checking your apps on the internet…";
  if (routes.error && !data) summary = "Gluon can't read your public addresses right now.";
  else if (entries) {
    const live = entries.filter((e) => e.on && !e.isRedirect);
    const n = live.length;
    const broken = live.filter((e) => e.health.state === "unhealthy");
    const open = live.filter((e) => e.needsLogin);
    const attn = live.filter((e) => e.health.state === "attention");
    const unsure = live.filter((e) => e.login.tone === "unknown");
    const count = (k: number) => `${k} app${k === 1 ? "" : "s"}`;
    if (!n) summary = "Nothing on this server is on the internet.";
    else if (broken.length)
      summary = (
        <>
          <b>{broken.length === 1 ? `${broken[0]!.name} can't be reached from the internet.` : `${broken.length} apps can't be reached from the internet.`}</b> {n - broken.length > 0 ? `The other ${count(n - broken.length)} ${n - broken.length === 1 ? "is" : "are"} fine.` : ""}
        </>
      );
    else if (open.length)
      summary = (
        <>
          <b>{open.length === 1 ? `${open[0]!.name} is on the internet without a login.` : `${open.length} apps are on the internet without a login.`}</b> {count(n)} in total, all reachable.
        </>
      );
    else if (attn.length)
      summary = (
        <>
          <b>{attn.length === 1 ? `${attn[0]!.name} needs a look.` : `${attn.length} apps need a look.`}</b> The rest are working.
        </>
      );
    else if (!status.data) summary = `${count(n)} on the internet. Checking each one…`;
    else if (unsure.length) summary = `${count(n)} on the internet, all working. Gluon isn't sure whether ${unsure.map((e) => e.name).join(" and ")} ${unsure.length === 1 ? "has" : "have"} a login.`;
    else {
      const partial = live.filter((e) => e.login.tone === "partial");
      summary = partial.length
        ? `${count(n)} on the internet, all working. Each asks for a login, except ${partial.map((e) => e.name).join(" and ")}, which ${partial.length === 1 ? "shows" : "show"} only a few paths.`
        : `${count(n)} on the internet, all working, and each asks for a login.`;
    }
  }

  // ---- the map
  const dns = dnsHop(status.data);
  const mapModel: MapModel | null = data
    ? {
        baseDomain: data.config.base_domain,
        serverName,
        direct: dns.direct,
        proxy: dns.proxy,
        router: routerHop(status.data, ddns.data),
        caddy: caddyHop(status.data, data.caddyRunning && (status.data?.caddyRunning ?? true)),
        apps: appsHop(entries),
        directCount: entries?.filter((e) => e.on && e.main.lane === "direct").length ?? 0,
        proxyCount: entries?.reduce((n, e) => n + [e.main, ...e.also].filter((a) => a.enabled && a.lane === "cloudflare").length, 0) ?? 0,
      }
    : null;

  const showDrift = !!data?.drift && (data.driftInfo?.settingLines ?? 1) > 0;

  return (
    <Page>
      <PageHeader
        title="Network"
        summary={summary}
        actions={
          <>
            <Button variant="primary" icon={<Plus />} disabled={!data} onClick={() => setFlow({ mode: "new" })}>
              Put an app on the internet
            </Button>
            <Menu
              trigger={
                <IconButton label="More" variant="secondary">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                { label: "Check everything now", icon: <Refresh />, onSelect: () => void recheck(), disabled: checking },
                { label: "Add a short link", description: `A path on ${data?.config.base_domain ?? "the main domain"} that redirects`, icon: <LinkIcon />, onSelect: () => setFlow({ mode: "redirect" }), disabled: !data },
                { label: "Add a chat server", description: "An XMPP server people sign in to from chat apps", icon: <ChatBubble />, onSelect: () => setChat({ mode: "new" }), disabled: !data },
                { label: "Redirect a domain", description: "Send a whole domain to another address", icon: <LinkIcon />, onSelect: () => setHostRedirect({ mode: "new" }), disabled: !data },
                "separator",
                { label: "History", description: "Earlier versions, restore one", icon: <ClockRotateRight />, onSelect: () => setHistory(true), disabled: !data },
                { label: "Caddyfile", description: "The web server's settings file", icon: <Code />, onSelect: () => setCaddyfile(true), disabled: !data },
              ]}
            />
          </>
        }
      />

      {routes.error && !data ? (
        <Notice tone="fault" title="Can't read the public addresses" action={<Button size="sm" onClick={() => void routes.mutate()}>Try again</Button>}>
          {routes.error.message}
        </Notice>
      ) : !data || !mapModel ? (
        <div className={s.stack}>
          <Skeleton height={240} radius={12} />
          <Skeleton height={320} radius={12} />
        </div>
      ) : (
        <div className={s.stack}>
          {!data.caddyRunning && (
            <Notice tone="fault" title="The web server isn't answering">
              Gluon can&rsquo;t reach Caddy, so nothing can be published or changed until it&rsquo;s back. Check that the proxy app is running in Apps.
            </Notice>
          )}
          {showDrift && (
            <Notice tone="attention" action={<Button size="sm" onClick={() => setCaddyfile(true)}>Review</Button>}>
              {driftSentence(data.driftInfo ?? null)}
            </Notice>
          )}

          <div ref={mapRef} className={s.mapAnchor}>
            <Panel title="How visitors reach your apps" flush>
              <NetworkMap
                model={mapModel}
                open={hop}
                onOpen={setHop}
                onApps={() => {
                  listRef.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
                  listRef.current?.focus({ preventScroll: true });
                }}
                detailsId={detailsId}
                detailsTitle={hop && hop !== "apps" ? HOP_TITLE[hop] : undefined}
              >
                {hop === "dns" && <DnsDetails status={status.data} statusError={status.error?.message ?? null} onRecheck={() => void recheck()} checking={checking} />}
                {hop === "router" && <RouterDetails status={status.data} ddns={ddns.data} ddnsError={ddns.error?.message ?? null} />}
                {hop === "caddy" && <CaddyDetails data={data} status={status.data} onRecheck={() => void recheck()} checking={checking} onCaddyfile={() => setCaddyfile(true)} onHistory={() => setHistory(true)} />}
              </NetworkMap>
            </Panel>
          </div>

          {status.error && !status.data && (
            <Notice tone="fault" title="Couldn't check the addresses" action={<Button size="sm" onClick={() => void recheck()}>Try again</Button>}>
              {status.error.message} The list is still accurate; only the live checks are missing.
            </Notice>
          )}

          <AppList
            ref={listRef}
            entries={entries}
            baseDomain={data.config.base_domain}
            busy={busy}
            highlight={highlight}
            onOpen={openEntry}
            onToggle={toggleEntry}
            onHomeOnly={homeOnly}
            onMarkLogin={(e) => void markLogin(e, "yes")}
            onPublish={() => setFlow({ mode: "new" })}
            statusLoading={!status.data && !status.error}
          />

          <HomeReach report={exposure.data} error={exposure.error?.message ?? null} refreshing={refreshingExposure} onRefresh={() => void refreshExposure()} />
        </div>
      )}

      {data && entry && (
        <AppDetails
          entry={entry}
          baseDomain={data.config.base_domain}
          open={detailsOpen}
          onOpenChange={(o) => {
            setDetailsOpen(o);
            if (!o) setHighlight(null);
          }}
          busy={busy === entry.key}
          statusLoading={!status.data && !status.error}
          checkedAt={status.data?.checkedAt ?? null}
          onEdit={editRoute}
          onEditFallback={() => {
            setDetailsOpen(false);
            setFlow({ mode: "fallback" });
          }}
          onRecheck={() => void recheck()}
          onSetUpChat={(id) => {
            setDetailsOpen(false);
            setChat({ mode: "convert", id });
          }}
          onToggleAddress={toggleAddress}
          onRemoveAddress={removeAddress}
          onRemoveApp={removeApp}
          onMarkLogin={(e, v) => void markLogin(e, v)}
          onHomeOnly={homeOnly}
        />
      )}
      {data && flow && (
        <PublishFlow
          key={JSON.stringify(flow)}
          target={flow}
          data={data}
          apps={apps.data}
          exposure={exposure.data}
          publicIp={status.data?.publicIp.v4 ?? null}
          commit={commit}
          onClose={() => setFlow(null)}
          onReload={() => void routes.mutate()}
          onEditInstead={(id) => setFlow({ mode: "edit", id })}
          onLoginChanged={() => {
            void apps.mutate();
            void refreshExposure(true);
          }}
        />
      )}
      {data && hostRedirect && <HostRedirectFlow key={JSON.stringify(hostRedirect)} target={hostRedirect} data={data} commit={commit} onClose={() => setHostRedirect(null)} onReload={() => void routes.mutate()} />}
      {data && chat && <ChatServerFlow key={JSON.stringify(chat)} target={chat} data={data} status={status.data} commit={commit} onClose={() => setChat(null)} onReload={() => void routes.mutate()} />}
      {data && (
        <HistoryDialog
          open={history}
          onOpenChange={setHistory}
          data={data}
          onRestored={() => {
            void routes.mutate();
            void status.mutate();
          }}
        />
      )}
      {data && <CaddyfileDialog open={caddyfile} onOpenChange={setCaddyfile} onRewrite={() => commit(data.config.routes, { success: "The web server's settings file is Gluon's version again." })} />}
      {confirmNode}
    </Page>
  );
}

