"use client";
import * as React from "react";
import { isWebUrl, openAppUrl } from "@/lib/client/open-link";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OpenNewWindow, Refresh, Play, Square, MoreHoriz, CloudDownload, Folder, Eye, EyeClosed, Trash, Pin, PinSlash, Import } from "iconoir-react";
import { usePinToHome } from "@/components/home/pinned";
import type { AppDetail } from "@/server/docker/detail";
import type { AppSummary } from "@/server/docker/apps";
import { api, useApi, streamPost, ApiError } from "@/lib/client/api";
import { useContainerStats } from "@/lib/client/live";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Field";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { StreamDialog, emptyStream, reduceStream, type StreamEvent, type StreamState } from "@/components/ui/StreamLog";
import type { MenuEntry } from "@/components/ui/Menu";
import { TimeChart } from "@/components/charts/TimeChart";
import { sourceName } from "@/lib/app-names";
import { moveBlock, uninstallRoute, type MoveJob } from "@/lib/app-move-types";
import { AppIcon } from "./AppIcon";
import { LogViewer } from "./LogViewer";
import { AppSettings } from "./AppSettings";
import { StackDiagram } from "./StackDiagram";
import { OperationProgress } from "./OperationProgress";
import { removeCopyConfirm, stopCopyConfirm } from "./copies";
import { reduceUmbrelStream, umbrelBusy } from "./umbrelStream";
import { MoveDialog } from "./MoveDialog";
import { useMoveWatch } from "./useMoveWatch";
import { UninstallDialog } from "./UninstallDialog";
import { serviceKind } from "@/lib/service-kind";
import s from "./detail.module.css";

const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel").then((m) => m.ChatPanel), {
  ssr: false,
  loading: () => <Skeleton height={420} radius={12} />,
});
const VoicePanel = dynamic(() => import("@/components/voice/VoicePanel").then((m) => m.VoicePanel), {
  ssr: false,
  loading: () => <Skeleton height={420} radius={12} />,
});
const ComposeEditor = dynamic(() => import("./ComposeEditor").then((m) => m.ComposeEditor), {
  ssr: false,
  loading: () => <Skeleton height={420} radius={12} />,
});

type Tab = "overview" | "chat" | "voice" | "logs" | "compose" | "settings";

export function AppDetailView({ initial, tab: asked, container, members }: { initial: AppDetail; tab: Tab; container: string | null; members: { id: string; name: string }[] }) {
  const router = useRouter();
  const { viewer } = usePrefs();
  const { data: app = initial, mutate } = useApi<AppDetail>(`/api/apps/${encodeURIComponent(initial.id)}`, { refresh: 8000, fallbackData: initial });
  const movedFrom = app.gluon?.movedFrom ?? null;
  const { data: allApps } = useApi<AppSummary[]>(app.copyOf || movedFrom ? "/api/apps" : null, { refresh: 30_000 });
  const [moveOpen, setMoveOpen] = React.useState(false);
  // Only while a move involves this app (the page's own refresh says so) or its dialog is open.
  const { data: moveState, mutate: refreshMove } = useApi<{ job: MoveJob | null }>(!app.self && (app.moving || moveOpen) ? `/api/apps/${encodeURIComponent(initial.id)}/move?only=job` : null, { refresh: 4000 });
  useMoveWatch(app.moving ? [app.id] : [], moveOpen ? app.id : null, () => {
    void mutate();
    void refreshMove();
  });
  const [uninstallOpen, setUninstallOpen] = React.useState(false);
  const [uninstallTitle, setUninstallTitle] = React.useState<string | undefined>(undefined);
  const askUninstall = (title?: string) => {
    setUninstallTitle(title);
    setUninstallOpen(true);
  };
  const [busy, setBusy] = React.useState<string | null>(null);
  const [stream, setStream] = React.useState<StreamState>(emptyStream);
  const [streamOpen, setStreamOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const base = `/apps/${encodeURIComponent(app.id)}`;
  const apiBase = `/api/apps/${encodeURIComponent(app.id)}`;
  const open = viewer.zone === "home" ? (app.urls.home ?? app.urls.away) : (app.urls.away ?? app.urls.home);
  const pinHome = usePinToHome();
  const pinned = pinHome.isPinned(app.id);

  async function act(action: "start" | "stop" | "restart") {
    setBusy(action);
    try {
      const r = await api.post<{ message: string }>(`${apiBase}/action`, { action });
      toast.success(r.message);
      void mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  async function containerAct(name: string, action: "restart" | "stop" | "start") {
    setBusy(name);
    try {
      await api.post(`${apiBase}/action`, { container: name, action });
      toast.success(`${action === "restart" ? "Restarted" : action === "stop" ? "Stopped" : "Started"} ${name}`);
      void mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  async function update() {
    const reduce = app.umbrel ? reduceUmbrelStream : reduceStream;
    setStream(emptyStream);
    setStreamOpen(true);
    setRunning(true);
    try {
      await streamPost<StreamEvent>(`${apiBase}/update`, {}, (e) => setStream((st) => reduce(st, e)));
    } catch (e) {
      const message = e instanceof ApiError && e.code === "reauth_cancelled" ? "Cancelled. Nothing was changed." : e instanceof Error ? e.message : "The update failed.";
      setStream((st) => reduce(st, { type: "error", message }));
    } finally {
      setRunning(false);
      void mutate();
    }
  }

  async function setHidden(hidden: boolean) {
    try {
      await api.patch(`${apiBase}/prefs`, { hidden });
      toast.info(hidden ? `${app.name} is hidden from Apps and Status` : `${app.name} shows in lists again`);
      void mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    }
  }

  const stopped = app.line === "stopped";
  const umbrel = app.umbrel;
  const umbrelWorking = umbrelBusy(umbrel?.state);
  const canUpdate = !app.self && !umbrelWorking && !app.copyOf && (!!app.configFile || !!umbrel);
  const primary = app.copyOf ? allApps?.find((a) => a.id === app.copyOf!.id) : undefined;
  const oldCopy = movedFrom ? allApps?.find((a) => a.id === movedFrom.id) : undefined;
  const moving = !!app.moving && !!moveState?.job && !moveState.job.finishedAt;
  const moveWhy = moveBlock(app) ?? (moving ? "It's moving right now" : null);
  const un = uninstallRoute(app);
  const kind = app.self ? null : serviceKind(app.details.map((d) => d.image));
  // A link to a tab this app doesn't have (Chat server on a non-Prosody app) lands on Overview.
  const tab: Tab = (asked === "chat" && kind !== "prosody") || (asked === "voice" && kind !== "mumble") ? "overview" : asked;

  const confirmUpdate = () =>
    confirm({
      title: umbrel?.latest ? `Update ${app.name} to ${umbrel.latest}?` : `Update ${app.name}?`,
      description: umbrel
        ? "Umbrel downloads the new version and restarts the app. It's usually unavailable for a minute or two."
        : "Gluon downloads the newest images for this app and recreates any container whose image changed. It's usually down for a few seconds.",
      confirmLabel: "Update",
      variant: "primary",
      onConfirm: async () => void update(),
    });

  const confirmUninstall = () =>
    confirm({
      title: `Uninstall ${app.name}?`,
      consequences: [
        "Umbrel removes the app and everything it stored. This can't be undone.",
        ...(app.routes.some((r) => r.enabled) ? ["Its public address will show an error until you remove or change it."] : []),
        ...(app.household ? ["Household members lose it from their apps."] : []),
      ],
      typeToConfirm: app.name,
      confirmLabel: "Uninstall",
      onConfirm: async () => {
        try {
          await api.post(`${apiBase}/action`, { action: "uninstall" });
        } catch (e) {
          if (e instanceof ApiError && e.code === "reauth_cancelled") return;
          throw e;
        }
        toast.success(`Uninstalling ${app.name}`, { description: "Umbrel is removing it. It leaves Apps when it's done." });
        router.push("/apps");
      },
    });

  const confirmRemoveCopy = () =>
    confirm(
      removeCopyConfirm(app, primary, async () => {
        try {
          await api.post(`${apiBase}/action`, { action: "down" });
        } catch (e) {
          if (e instanceof ApiError && e.code === "reauth_cancelled") return;
          throw e;
        }
        toast.success(`Removed the old ${app.name}`, { description: "Its folders are still on disk." });
        router.push(app.copyOf ? `/apps/${encodeURIComponent(app.copyOf.id)}` : "/apps");
      }),
    );

  const moreItems: MenuEntry[] = [
    {
      label: "Update",
      description: app.self
        ? "Gluon can't update itself from here"
        : app.copyOf
          ? "Old copies aren't updated"
          : umbrel
            ? umbrelWorking
              ? "Umbrel is busy with this app"
              : umbrel.latest
                ? `Umbrel updates it to ${umbrel.latest}`
                : "Ask Umbrel for the newest version"
            : app.configFile
              ? "Download newer images and recreate"
              : "Only Compose apps can be updated from here",
      icon: <CloudDownload />,
      disabled: !canUpdate,
      onSelect: confirmUpdate,
    },
    ...(app.workingDir ? [{ label: "Show its folder in Files", icon: <Folder />, href: `/files?path=${encodeURIComponent(app.workingDir)}` }] : []),
    app.hidden
      ? { label: "Show in lists", icon: <Eye />, onSelect: () => void setHidden(false) }
      : { label: "Hide from lists", icon: <EyeClosed />, description: "It keeps running", onSelect: () => void setHidden(true) },
    ...(!app.self && app.source !== "gluon" && !app.copyOf
      ? [{ label: "Move to Gluon…", description: moveWhy ?? "Gluon runs it from its own folder", icon: <Import />, disabled: !!moveWhy, onSelect: () => setMoveOpen(true) }]
      : []),
    ...(app.copyOf && app.configFile && !app.self ? (["separator", { label: stopped ? "Remove this old copy" : "Stop and remove this old copy", icon: <Trash />, danger: true, onSelect: confirmRemoveCopy }] as MenuEntry[]) : []),
    ...(un.via === "builder"
      ? (["separator", { label: "Remove in the builder", description: "You made this app in Gluon", icon: <Trash />, href: `/apps/custom/${encodeURIComponent(app.gluon!.builderId!)}` }] as MenuEntry[])
      : un.via === "gluon" && !app.self && !(app.copyOf && app.configFile)
        ? (["separator", { label: "Uninstall…", description: un.block ?? "Keep or delete its data", icon: <Trash />, danger: true, disabled: !!un.block || moving, onSelect: () => askUninstall(app.copyOf ? `Remove the old ${app.name}?` : undefined) }] as MenuEntry[])
        : un.via === "umbrel" && !umbrel
          ? (["separator", { label: "Uninstall", description: un.block ?? "", icon: <Trash />, danger: true, disabled: true }] as MenuEntry[])
          : []),
    ...(umbrel && !app.self
      ? (["separator", { label: "Uninstall", description: "Remove it and its data from Umbrel", icon: <Trash />, danger: true, disabled: umbrelWorking, onSelect: confirmUninstall }] as MenuEntry[])
      : []),
  ];

  return (
    <Page>
      <PageHeader
        back={{ href: "/apps", label: "Apps" }}
        title={
          <span className={s.title}>
            <AppIcon src={app.icon} name={app.name} size={40} />
            <span className={s.titleText}>{app.name}</span>
          </span>
        }
        summary={
          <span className={s.summary}>
            <StateLine state={app.line} label={app.copyOf ? (stopped ? "Old copy, stopped" : "Old copy, still running") : app.summary} />
            {app.description && app.description.trim().toLowerCase() !== app.name.trim().toLowerCase() && <span className={s.desc}>{app.description}</span>}
          </span>
        }
        actions={
          <>
            {open && !app.copyOf && (
              <IconButton label={pinned ? "Unpin from Home" : "Pin to Home"} variant="secondary" aria-pressed={pinned} onClick={() => void pinHome.toggle(app)}>
                {pinned ? <PinSlash /> : <Pin />}
              </IconButton>
            )}
            {open && !app.copyOf && (
              <Button icon={<OpenNewWindow />} onClick={() => openAppUrl(open)}>
                {open.startsWith("mumble:") ? "Open in Mumble" : "Open"}
              </Button>
            )}
            {!app.copyOf && (
              <Button icon={<Refresh />} loading={busy === "restart"} disabled={stopped || umbrelWorking} onClick={() => void act("restart")}>
                Restart
              </Button>
            )}
            {stopped ? (
              <Button variant={app.copyOf ? "secondary" : "primary"} icon={<Play />} loading={busy === "start"} disabled={umbrelWorking} onClick={() => void act("start")}>
                Start
              </Button>
            ) : (
              <Button
                icon={<Square />}
                loading={busy === "stop"}
                disabled={app.self || umbrelWorking}
                onClick={() =>
                  confirm(
                    app.copyOf
                      ? stopCopyConfirm(app, primary, () => act("stop"))
                      : {
                          title: `Stop ${app.name}?`,
                          consequences: [
                            `${app.name} won't be reachable until you start it again.`,
                            ...(app.routes.some((r) => r.enabled) ? ["Its public address will show an error in the meantime."] : []),
                            ...(app.household ? ["Household members will see it as not working."] : []),
                          ],
                          confirmLabel: "Stop",
                          variant: "primary",
                          onConfirm: () => act("stop"),
                        },
                  )
                }
              >
                Stop
              </Button>
            )}
            <Menu
              trigger={
                <IconButton label="More actions" variant="secondary">
                  <MoreHoriz />
                </IconButton>
              }
              items={moreItems}
            />
          </>
        }
      />

      {moving ? (
        <div className={s.banner}>
          <Notice
            tone="attention"
            title={moveState!.job!.appId === app.id ? `Moving ${app.name} to Gluon` : `${app.name} is being set up from ${moveState!.job!.name}`}
            action={
              <Button size="sm" onClick={() => setMoveOpen(true)}>
                Show progress
              </Button>
            }
          >
            Gluon is copying its data and starting the new copy. Leave it running; it puts everything back if the copy doesn't start.
          </Notice>
        </div>
      ) : app.copyOf ? (
        <div className={s.banner}>
          <Notice
            title={`An old copy of ${app.copyOf.name}`}
            action={
              app.self ? undefined : app.configFile ? (
                <Button size="sm" onClick={confirmRemoveCopy}>
                  {stopped ? "Remove it…" : "Stop and remove…"}
                </Button>
              ) : umbrel ? (
                <Button size="sm" disabled={umbrelWorking} onClick={confirmUninstall}>
                  Uninstall it in Umbrel…
                </Button>
              ) : (
                <Button size="sm" onClick={() => askUninstall(`Remove the old ${app.name}?`)}>
                  Remove it…
                </Button>
              )
            }
          >
            It was installed from {sourceName(app.source)}. <Link href={`/apps/${encodeURIComponent(app.copyOf.id)}`}>{app.copyOf.name} from {sourceName(app.copyOf.source)}</Link> is the one in use
            {app.configFile ? "." : `. It shares its Compose name with that app, so Gluon handles its containers one by one and won't run Compose on it.`}
          </Notice>
        </div>
      ) : movedFrom && oldCopy ? (
        <div className={s.banner}>
          <Notice
            title={`Moved here from ${sourceName(movedFrom.source)}`}
            action={
              <LinkButton size="sm" href={`/apps/${encodeURIComponent(oldCopy.id)}`}>
                Go to the old copy
              </LinkButton>
            }
          >
            The {sourceName(movedFrom.source)} copy is {oldCopy.line === "stopped" ? "stopped" : "still running"} and keeps its data. Remove it once you&apos;re sure this one works.
          </Notice>
        </div>
      ) : umbrel ? (
        <UmbrelNotice app={app} busy={umbrelWorking} onUpdate={confirmUpdate} />
      ) : app.source === "casaos" && tab === "compose" ? (
        <div className={s.banner}>
          <Notice title="CasaOS manages this file">If you later change this app's settings in CasaOS, CasaOS rewrites the file and your edits here are replaced.</Notice>
        </div>
      ) : null}

      <Tabs
        value={tab}
        hrefFor={(v) => (v === "overview" ? base : `${base}?tab=${v}`)}
        items={[
          { value: "overview", label: "Overview" },
          ...(kind === "prosody" ? [{ value: "chat" as const, label: "Chat server" }] : []),
          ...(kind === "mumble" ? [{ value: "voice" as const, label: "Voice server" }] : []),
          { value: "logs", label: "Logs" },
          ...(app.configFile ? [{ value: "compose" as const, label: "Compose file" }] : []),
          { value: "settings", label: "Settings" },
        ]}
        aria-label="App sections"
      />
      <div className={s.tabBody}>
        {tab === "overview" && <Overview app={app} busy={busy} onContainer={(n, a) => void containerAct(n, a)} />}
        {tab === "chat" && kind === "prosody" && <ChatPanel appId={app.id} appName={app.name} running={!stopped} />}
        {tab === "voice" && kind === "mumble" && <VoicePanel appId={app.id} appName={app.name} running={!stopped} />}
        {tab === "logs" && <LogViewer appId={app.id} containers={app.details.map((d) => ({ name: d.name, label: d.service ?? d.name }))} initialContainer={container} />}
        {tab === "compose" && app.configFile && <ComposeEditor appId={app.id} onApplied={() => void mutate()} />}
        {tab === "settings" && <AppSettings app={app} members={members} onSaved={() => void mutate()} />}
      </div>

      {umbrel ? (
        <Dialog
          open={streamOpen}
          onOpenChange={(o) => !o && setStreamOpen(false)}
          title={`Updating ${app.name}${umbrel.latest ? ` to ${umbrel.latest}` : ""}`}
          size="wide"
          footer={
            <Button variant={running ? "ghost" : "primary"} onClick={() => setStreamOpen(false)}>
              Close
            </Button>
          }
        >
          <OperationProgress state={stream} op="update" running={running} />
        </Dialog>
      ) : (
        <StreamDialog open={streamOpen} onClose={() => setStreamOpen(false)} title={`Updating ${app.name}`} state={stream} running={running} />
      )}
      {!app.self && (
        <MoveDialog
          app={app}
          open={moveOpen}
          onOpenChange={setMoveOpen}
          onFinished={() => {
            void mutate();
            void refreshMove();
          }}
          onRemoveOld={() => (umbrel ? confirmUninstall() : app.configFile ? confirmRemoveCopy() : askUninstall(`Remove the old ${app.name}?`))}
        />
      )}
      {!app.self && !app.umbrel && (
        <UninstallDialog
          app={app}
          title={uninstallTitle}
          open={uninstallOpen}
          onOpenChange={setUninstallOpen}
          onDone={(message) => {
            toast.success(message);
            router.push(app.copyOf ? `/apps/${encodeURIComponent(app.copyOf.id)}` : "/apps");
          }}
        />
      )}
      {confirmNode}
    </Page>
  );
}

// ---------------------------------------------------------------- Umbrel

const OFFICIAL_STORE = "umbrel-app-store";

/** Umbrel owns this app: its version, where it came from, what works here and what goes through Umbrel. */
function UmbrelNotice({ app, busy, onUpdate }: { app: AppDetail; busy: boolean; onUpdate: () => void }) {
  const u = app.umbrel!;
  // Community store names live in the store listing; only fetch it when we need one.
  const community = !!u.storeId && u.storeId !== OFFICIAL_STORE;
  const { data: store } = useApi<{ stores: { id: string; name: string }[] }>(community ? "/api/store" : null, { revalidateOnFocus: false });
  const storeName = !u.storeId ? null : u.storeId === OFFICIAL_STORE ? "the Umbrel App Store" : (store?.stores.find((x) => x.id === u.storeId)?.name ?? u.storeId);
  const update = u.latest && !app.self && !busy;
  const verb = u.state === "installing" ? "Installing" : u.state === "updating" ? "Updating" : "Removing";
  return (
    <div className={s.banner}>
      <Notice
        tone={update ? "attention" : "neutral"}
        title={update ? `${u.latest} is available` : "Umbrel looks after this app"}
        action={
          update ? (
            <Button size="sm" icon={<CloudDownload />} onClick={onUpdate}>
              Update to {u.latest}
            </Button>
          ) : undefined
        }
      >
        {busy ? (
          <span className={s.umbrelBusy}>
            <span>
              {verb} through Umbrel{u.progress ? `, ${u.progress}% done` : ""}.
            </span>
            <span className={s.track} role="progressbar" aria-label={`${verb} ${app.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.progress || undefined}>
              <span style={{ transform: `scaleX(${(u.progress || 0) / 100})` }} />
            </span>
          </span>
        ) : (
          <>
            {u.version ? `Version ${u.version}` : "Installed"}
            {storeName ? ` from ${storeName}${community ? ", a community store" : ""}` : ""}. Restart, stop, logs and files work here. Updating and removing it go through Umbrel, and Umbrel keeps its compose file.
          </>
        )}
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ app, busy, onContainer }: { app: AppDetail; busy: string | null; onContainer: (name: string, action: "restart" | "stop" | "start") => void }) {
  const fmt = useFormat();
  const stats = useContainerStats();
  const [range, setRange] = React.useState<"1h" | "24h" | "7d">("24h");
  const { data: hist } = useApi<Record<string, [number, number][]>>(`/api/apps/${encodeURIComponent(app.id)}/metrics?range=${range}`, { refresh: 60_000 });
  const windowMs = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 }[range];
  const base = `/apps/${encodeURIComponent(app.id)}`;

  // Sum containers into one series per metric, aligned by timestamp.
  const sum = (suffix: "cpu" | "mem") => {
    const m = new Map<number, number>();
    for (const c of app.containers) for (const [t, v] of hist?.[`ctr.${c.name}.${suffix}`] ?? []) m.set(t, (m.get(t) ?? 0) + v);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  };
  const liveCpu = app.containers.reduce((a, c) => a + (stats.get(c.name)?.cpu ?? 0), 0);
  const liveMem = app.containers.reduce((a, c) => a + (stats.get(c.name)?.mem ?? 0), 0);
  const publicRoutes = app.routes.filter((r) => r.enabled);

  return (
    <div className={s.grid}>
      <Panel title="How it's put together" meta={<span className={s.panelHint}>Hover to trace, click a container for its actions</span>} className={s.span2}>
        {app.details.length === 0 ? (
          <p className={s.padless}>{umbrelBusy(app.umbrel?.state) ? "Umbrel is still setting this app up. Its containers show up here once they're created." : "This app has no containers right now."}</p>
        ) : (
          <StackDiagram app={app} actions={{ onContainer, busy, logsHref: (c) => `${base}?tab=logs&container=${encodeURIComponent(c)}` }} />
        )}
      </Panel>

      <Panel
        title="Resources"
        meta={
          <Segmented
            aria-label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: "1h", label: "1 h" },
              { value: "24h", label: "24 h" },
              { value: "7d", label: "7 days" },
            ]}
          />
        }
        className={s.span2}
      >
        <div className={s.charts}>
          <div>
            <div className={s.chartHead}>
              <span className="label">CPU</span>
              <strong className="num">{fmt.percent(liveCpu, 1)}</strong>
            </div>
            {hist ? (
              <TimeChart series={[{ key: "cpu", label: "CPU", points: sum("cpu"), area: true }]} format={(v) => fmt.percent(v, 1)} formatTime={(t) => (range === "7d" ? fmt.date(t) : fmt.time(t))} windowMs={windowMs} live height={150} label={`${app.name} CPU use`} />
            ) : (
              <Skeleton height={150} />
            )}
          </div>
          <div>
            <div className={s.chartHead}>
              <span className="label">Memory</span>
              <strong className="num">{fmt.bytes(liveMem)}</strong>
            </div>
            {hist ? (
              <TimeChart series={[{ key: "mem", label: "Memory", points: sum("mem"), area: true }]} format={(v) => fmt.bytes(v)} formatTime={(t) => (range === "7d" ? fmt.date(t) : fmt.time(t))} windowMs={windowMs} live height={150} label={`${app.name} memory use`} />
            ) : (
              <Skeleton height={150} />
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Who can reach it">
        <dl className={s.kv}>
          <dt>The internet</dt>
          <dd>
            {publicRoutes.length ? (
              <>
                Yes, at {publicRoutes.map((r) => r.url.replace(/^https?:\/\//, "")).join(" and ")}.{" "}
                {app.hasLogin === "yes" ? "It asks for its own login." : app.hasLogin === "no" ? <b>Anyone who finds it can use it; it has no login.</b> : <span className={s.faint}>Gluon doesn't know if it has a login (set it in Settings).</span>}
              </>
            ) : (
              <span className={s.faint}>
                No. <Link href={`/network?publish=${encodeURIComponent(app.id)}`}>Publish it</Link> to reach it away from home.
              </span>
            )}
          </dd>
          <dt>Your home network</dt>
          <dd>{app.urls.home ? <a href={app.urls.home} target={isWebUrl(app.urls.home) ? "_blank" : undefined} rel="noopener noreferrer" className="mono">{app.urls.home.replace(/^https?:\/\//, "")}</a> : <span className={s.faint}>No web page</span>}</dd>
          <dt>Household</dt>
          <dd>
            {app.household ? "Everyone sees it on their home page." : app.access.length ? `${fmt.plural(app.access.length, "person", "people")} can see it.` : <span className={s.faint}>Only admins see it.</span>}{" "}
            <Link href={`${base}?tab=settings`}>Change</Link>
          </dd>
        </dl>
      </Panel>

      <Panel title="Recent events" flush>
        {app.events.length === 0 ? (
          <p className={s.pad}>Nothing since Gluon started watching. Starts, stops and crashes show up here.</p>
        ) : (
          <ul className={s.events} role="list">
            {app.events.slice(0, 12).map((e, i) => (
              <li key={i} data-bad={e.action === "oom" || e.action.includes("unhealthy") ? "" : undefined}>
                <Time ts={e.t} kind="dateTime" className={`${s.faint} num`} />
                <span>
                  <span className="mono">{e.name}</span> {describeEvent(e.action, e.exitCode)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {app.details.length > 0 && (
        <Panel title="Settings inside the app" meta={<span className={s.panelHint}>Environment variables; secrets stay hidden until you ask</span>} flush className={s.span2}>
          <EnvTable app={app} />
        </Panel>
      )}
    </div>
  );
}

function describeEvent(action: string, exit: number | null) {
  if (action === "die") return exit ? `stopped with code ${exit}` : "stopped";
  if (action === "start") return "started";
  if (action === "oom") return "ran out of memory";
  if (action.startsWith("health_status")) return action.includes("unhealthy") ? "became unhealthy" : "is healthy again";
  if (action === "kill") return "was sent a stop signal";
  return action;
}

function EnvTable({ app }: { app: AppDetail }) {
  const [revealed, setRevealed] = React.useState<Record<string, string>>({});
  const [which, setWhich] = React.useState(app.details[0]?.name ?? "");
  const d = app.details.find((x) => x.name === which) ?? app.details[0];
  if (!d) return null;
  const reveal = async (key: string) => {
    try {
      const r = await api.post<{ value: string }>(`/api/apps/${encodeURIComponent(app.id)}/env`, { container: d.name, key });
      setRevealed((m) => ({ ...m, [`${d.name}:${key}`]: r.value }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(e instanceof Error ? e.message : "Couldn't show that.");
    }
  };
  return (
    <div>
      {app.details.length > 1 && (
        <div className={s.envPick}>
          <Segmented aria-label="Container" value={which} onChange={setWhich} options={app.details.map((x) => ({ value: x.name, label: x.service ?? x.name }))} />
        </div>
      )}
      {d.env.length === 0 ? (
        <p className={s.pad}>No environment settings.</p>
      ) : (
        <dl className={s.env}>
          {d.env.map((e) => {
            const key = `${d.name}:${e.key}`;
            return (
              <React.Fragment key={e.key}>
                <dt className="mono">{e.key}</dt>
                <dd className="mono">
                  {e.secret && revealed[key] === undefined ? (
                    <button type="button" className={s.reveal} onClick={() => void reveal(e.key)}>
                      <Eye aria-hidden /> Hidden. Show
                    </button>
                  ) : (
                    (revealed[key] ?? e.value) || <span className={s.faint}>(empty)</span>
                  )}
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      )}
    </div>
  );
}
