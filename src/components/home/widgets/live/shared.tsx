"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import useSWR, { mutate } from "swr";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Button, LinkButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import type { ConnectTarget } from "../../connect/Connect";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import {
  WIDGET_REFRESH_MS,
  type IntegrationKind,
  type IntegrationRef,
  type WidgetBatchResponse,
  type WidgetCatalog,
  type WidgetDataMap,
  type WidgetResponse,
  type WidgetType,
} from "@/lib/widgets-types";
import type { LineState } from "@/lib/types";
import l from "./live.module.css";

export const KIND_LABEL: Record<IntegrationKind, string> = {
  jellyfin: "Jellyfin",
  immich: "Immich",
  subsonic: "a music server",
  slskd: "slskd",
  homebridge: "Homebridge",
  homeassistant: "Home Assistant",
  coolify: "Coolify",
  "generic-json": "a JSON address",
};
const KIND_NAME: Record<IntegrationKind, string> = {
  jellyfin: "Jellyfin",
  immich: "Immich",
  subsonic: "the music server",
  slskd: "slskd",
  homebridge: "Homebridge",
  homeassistant: "Home Assistant",
  coolify: "Coolify",
  "generic-json": "that address",
};

// Only widgets that still need connecting show the connect step, so its form loads with the first of them.
const ConnectDialog = dynamic(() => import("../../connect/Connect").then((m) => m.ConnectDialog), { ssr: false });

// ---------------------------------------------------------------- integrations this viewer can use

/** Connected apps the viewer may use, grouped by kind (from the widget catalog, refreshed every 5 minutes). */
export function useUsableIntegrations() {
  const { data, error, isLoading } = useApi<WidgetCatalog>("/api/widgets/catalog", { refresh: 300_000, revalidateOnFocus: false });
  const byKind = React.useMemo(() => {
    const m = new Map<IntegrationKind, IntegrationRef[]>();
    for (const t of data?.types ?? []) {
      for (const r of t.integrations) {
        const list = m.get(r.kind) ?? [];
        if (!list.some((x) => x.id === r.id)) list.push(r);
        m.set(r.kind, list);
      }
    }
    return m;
  }, [data]);
  return { byKind, loaded: !!data, error, isLoading };
}

export type Source = { state: "loading" } | { state: "none" } | { state: "gone" } | { state: "ok"; ref: IntegrationRef };

/** The integration a widget reads from: the configured one, else the first one available. */
export function useSource(kind: IntegrationKind, configured: string | undefined): Source {
  const { byKind, loaded } = useUsableIntegrations();
  if (!loaded) return { state: "loading" };
  const list = byKind.get(kind) ?? [];
  if (configured) {
    const ref = list.find((r) => r.id === configured);
    return ref ? { state: "ok", ref } : { state: "gone" };
  }
  return list[0] ? { state: "ok", ref: list[0] } : { state: "none" };
}

// ---------------------------------------------------------------- data

async function fetchWidget([, type, integration, config]: readonly [string, WidgetType, string | undefined, string]) {
  const res = await api.post<WidgetBatchResponse>("/api/widgets/data", {
    widgets: [
      {
        key: "w",
        type,
        integration,
        config: JSON.parse(config) as Record<string, unknown>,
      },
    ],
  });
  const r = res.results[0];
  if (!r) throw new ApiError("empty", "The server sent nothing back.", 500);
  if (!r.ok) throw new ApiError(r.error.code, r.error.message, 502);
  return r as unknown as WidgetResponse;
}

/**
 * Widget data through one batched POST, keyed by type + integration + config, polled at the type's interval.
 * Keeps the last answer on screen while refreshing or when a refresh fails.
 */
export function useWidgetData<T extends WidgetType>(type: T, integration: string | null | undefined, config: Record<string, unknown>, enabled = true) {
  const key = enabled ? (["widget", type, integration ?? undefined, JSON.stringify(config)] as const) : null;
  const swr = useSWR<WidgetResponse, ApiError>(key, fetchWidget, {
    refreshInterval: WIDGET_REFRESH_MS[type],
    revalidateOnFocus: true,
    keepPreviousData: true,
    dedupingInterval: Math.min(4000, WIDGET_REFRESH_MS[type] - 500),
    errorRetryCount: 2,
  });
  return {
    data: swr.data?.type === type ? (swr.data.data as WidgetDataMap[T]) : undefined,
    response: swr.data as WidgetResponse<T> | undefined,
    error: swr.error,
    loading: !swr.data && !swr.error,
    retry: () => void swr.mutate(),
    validating: swr.isValidating,
  };
}

// ---------------------------------------------------------------- states

/** The installed app a widget of this kind can connect to (or reconnect, when it already has a connection). */
export function useConnectTarget(kind: IntegrationKind, integrationId?: string | null): ConnectTarget | null {
  const { data } = useApi<WidgetCatalog>("/api/widgets/catalog", {
    refresh: 300_000,
    revalidateOnFocus: false,
  });
  return React.useMemo(() => {
    const candidates = (data?.apps ?? []).filter((a) => !a.duplicate).flatMap((a) => a.services.filter((sv) => sv.kind === kind && sv.connect).map((sv) => ({ a, sv })));
    const hit = integrationId ? candidates.find((x) => x.sv.integrationId === integrationId) : (candidates.find((x) => x.sv.state === "none") ?? candidates[0]);
    if (!hit) return null;
    return {
      appId: hit.a.appId,
      appName: hit.a.name,
      icon: hit.a.icon,
      line: hit.a.line,
      service: hit.sv,
      integrationId: integrationId ?? null,
    };
  }, [data, kind, integrationId]);
}

/** One calm block for every widget state: an optional line glyph, a title, a sentence, and at most one action. */
export function WidgetState({ line, title, children, action }: { line?: LineState; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={l.state} role="status">
      <div>
        <b className={l.stateTitle}>
          {line && <StateLine state={line} size={13} />}
          {title}
        </b>
        {children}
      </div>
      {action}
    </div>
  );
}

/** A button that opens the compact connect step for this kind, right on the widget. */
function ConnectButton({ kind, integrationId, label }: { kind: IntegrationKind; integrationId?: string | null; label: string }) {
  const target = useConnectTarget(kind, integrationId);
  const [open, setOpen] = React.useState(false);
  if (!target) {
    return (
      <LinkButton href="/settings/integrations" size="sm">
        Open Connected apps
      </LinkButton>
    );
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConnectDialog target={target} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** "Not connected" / "removed" states: admins connect right here, members get who to ask. */
export function NotConnected({ kind, gone }: { kind: IntegrationKind; gone?: boolean }) {
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  return (
    <WidgetState
      title={gone ? "This widget's connection is gone" : `${cap(KIND_LABEL[kind])} isn't connected`}
      action={admin ? <ConnectButton kind={kind} label={`Connect ${KIND_NAME[kind].replace(/^the /, "")}`} /> : undefined}
    >
      {admin
        ? gone
          ? "It was removed or stopped being shared. Connect it again, or pick another in this widget's settings."
          : `Connect ${KIND_NAME[kind]} and this widget fills in. It takes a moment.`
        : gone
          ? "Whoever runs the server removed it or stopped sharing it. Ask them, or remove this widget."
          : `Ask whoever runs the server to connect ${KIND_NAME[kind]} and share it with the household.`}
    </WidgetState>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The app behind a connection is stopped: say so plainly, and let admins start it from here. */
export function AppStopped({ kind, source }: { kind: IntegrationKind; source: IntegrationRef }) {
  const { viewer } = usePrefs();
  const [busy, setBusy] = React.useState(false);
  const name = cap(KIND_NAME[kind]);
  async function start() {
    if (!source.appId) return;
    setBusy(true);
    try {
      await api.post(`/api/apps/${encodeURIComponent(source.appId)}/action`, {
        action: "start",
      });
      toast.success(`Starting ${source.name}`, {
        description: "The widget fills in once it's up.",
      });
      await Promise.all([mutate("/api/widgets/catalog"), mutate("/api/apps")]);
    } catch (e) {
      toast.error(`Couldn't start ${source.name}`, {
        description: e instanceof ApiError ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <WidgetState
      line="stopped"
      title={`${name} is stopped`}
      action={
        viewer.role === "admin" && source.appId ? (
          <Button size="sm" loading={busy} onClick={() => void start()}>
            Start {source.name}
          </Button>
        ) : undefined
      }
    >
      {viewer.role === "admin" ? "Start it and this widget picks up where it left off." : "It isn't running right now. Whoever runs the server can start it."}
    </WidgetState>
  );
}

/** A failed fetch with no data to show: auth failed → reconnect; can't reach → retry; bad settings → fix them. */
export function Problem({
  error,
  kind,
  subject,
  source,
  retry,
  openSettings,
}: {
  error: ApiError;
  kind?: IntegrationKind;
  subject?: string;
  source?: IntegrationRef;
  retry?: () => void;
  openSettings?: () => void;
}) {
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const who = subject ?? (kind ? cap(KIND_NAME[kind]) : "This source");
  const configProblem = error.code === "bad_request" || error.code === "invalid" || error.code === "bad_url" || error.code === "blocked_address";
  const auth = error.code === "upstream_auth" || error.code === "integration_broken";
  const unreachable = error.code === "unreachable" || error.code === "timeout";
  if (kind && auth) {
    // Name the app the key belongs to, and where it's fixed, in the words of the Settings page.
    const app = source?.name ?? cap(KIND_NAME[kind]);
    return (
      <WidgetState
        line="unhealthy"
        title={`The key for ${app} stopped working`}
        action={admin ? <ConnectButton kind={kind} integrationId={source?.id} label={`Reconnect ${app}`} /> : undefined}
      >
        {admin ? (
          <>
            Reconnect it here, or in Settings → Connected apps.
            <span className={l.stateWhy} title={error.message}>
              {error.message}
            </span>
          </>
        ) : (
          `${app} needs reconnecting. Whoever runs the server can do it in a minute.`
        )}
      </WidgetState>
    );
  }
  if (configProblem) {
    return (
      <WidgetState title="Check this widget's settings" action={openSettings ? <Button size="sm" onClick={openSettings}>Open settings</Button> : undefined}>
        {error.message}
      </WidgetState>
    );
  }
  if (error.code === "rate_limited") return <WidgetState title="Catching up">{error.message}</WidgetState>;
  // Members get a calm sentence; admins get the exact reason.
  const message = admin || !kind ? error.message : `${who} isn't answering right now. It usually comes back on its own.`;
  return (
    <WidgetState
      line={unreachable ? "unhealthy" : undefined}
      title={unreachable ? `Can't reach ${who === "This source" ? "it" : who}` : `Can't show ${who === "This source" ? "this" : who} right now`}
      action={
        retry ? (
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {message}
    </WidgetState>
  );
}

/** Centered empty message, same voice as core widgets. */
export function Quiet({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={l.state}>
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

/** Subtle "last updated" line when showing an old answer because the source is failing. */
export function StaleNote({ response, error }: { response?: WidgetResponse; error?: ApiError }) {
  if (!response || (!response.stale && !error)) return null;
  const why = response.stale?.message ?? error?.message ?? "";
  return (
    <p className={l.stale} title={why}>
      Last updated <Time ts={response.fetchedAt} />
    </p>
  );
}

// ---------------------------------------------------------------- skeletons shaped like content

export function RowsSkeleton({ rows = 3, thumb = 0, ratio = 1 }: { rows?: number; thumb?: number; ratio?: number }) {
  return (
    <div className={l.list} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={l.row}>
          {thumb > 0 && <Skeleton width={thumb} height={Math.round(thumb / ratio)} radius={6} />}
          <div className={l.rowText} style={{ display: "grid", gap: 6 }}>
            <Skeleton width={`${70 - i * 8}%`} height={12} />
            <Skeleton width={`${45 - i * 5}%`} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function StatsSkeleton({ n = 3 }: { n?: number }) {
  return (
    <div className={l.stats} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={l.stat}>
          <Skeleton width={48} height={9} />
          <Skeleton width={64} height={24} />
        </div>
      ))}
    </div>
  );
}

export function ShelfSkeleton({ rows = 1, square }: { rows?: number; square?: boolean }) {
  return (
    <div className={l.shelfWrap} aria-busy="true" aria-label="Loading">
      <div className={l.shelf} style={{ "--r": rows } as React.CSSProperties}>
        {Array.from({ length: 10 * rows }, (_, i) => (
          <div key={i} className={l.card} data-square={square ? "" : undefined}>
            <span className={l.poster} data-square={square ? "" : undefined}>
              <span className={l.posterSkel} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- images

/** Fixed-aspect image box: lazy, no layout shift, falls back to a lettered tile. */
export function Poster({ src, title, square, className }: { src: string | null | undefined; title: string; square?: boolean; className?: string }) {
  // State is tied to the src it was recorded for, so a new src starts fresh without an effect
  // (an effect could reset "loaded" after a cached image already fired onLoad).
  const [st, setSt] = React.useState<{
    src: string | null | undefined;
    loaded: boolean;
    failed: boolean;
  }>({ src, loaded: false, failed: false });
  const failed = st.src === src && st.failed;
  const loaded = st.src === src && st.loaded;
  const setFailed = () => setSt({ src, loaded: false, failed: true });
  const setLoaded = () => setSt({ src, loaded: true, failed: false });
  const letter = (title.trim().replace(/^(the|a|an)\s+/i, "")[0] ?? "?").toUpperCase();
  return (
    <span className={`${l.poster} ${className ?? ""}`} data-square={square ? "" : undefined} aria-hidden>
      {(!src || failed) && <span className={l.posterLetter}>{letter}</span>}
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded ? "" : undefined} onLoad={setLoaded} onError={setFailed} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------- settings: pick the integration

export function IntegrationPicker({ kind, value, onChange }: { kind: IntegrationKind; value: string | undefined; onChange: (id: string | undefined) => void }) {
  const { byKind, loaded } = useUsableIntegrations();
  const { viewer } = usePrefs();
  if (!loaded) return <Skeleton height={36} />;
  const list = byKind.get(kind) ?? [];
  if (!list.length) {
    return (
      <Notice tone="neutral" title={`${cap(KIND_LABEL[kind])} isn't connected`} action={viewer.role === "admin" ? <ConnectButton kind={kind} label="Connect" /> : undefined}>
        {viewer.role === "admin"
          ? `Connect ${KIND_NAME[kind]} first, then this widget can show it.`
          : `Ask whoever runs the server to connect ${KIND_NAME[kind]} and share it with the household.`}
      </Notice>
    );
  }
  const gone = value && !list.some((r) => r.id === value);
  const options = [
    {
      value: "auto",
      label: list.length > 1 ? `Automatic (${list[0]!.name})` : list[0]!.name,
    },
    ...(list.length > 1 ? list.map((r) => ({ value: r.id, label: r.name })) : []),
  ];
  return (
    <Field label="Connected app" description={gone ? "The one this widget used is gone; pick another." : list.length > 1 ? "Which connection this widget shows." : undefined}>
      <Select aria-label="Connected app" value={value && !gone && list.length > 1 ? value : "auto"} onChange={(v) => onChange(v === "auto" ? undefined : v)} options={options} />
    </Field>
  );
}

/** Value that settles `ms` after the last change (for previews while typing). */
export function useDebounced<T>(value: T, ms = 600): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** How many items fit at each size (used as the request limit). */
export function perSize<T>(size: string, map: Partial<Record<"s" | "m" | "t" | "l" | "w" | "x", T>>, fallback: T): T {
  return (map as Record<string, T>)[size] ?? fallback;
}

// ---------------------------------------------------------------- gate: source → data → content

interface Query<T> {
  data?: T;
  response?: WidgetResponse;
  error?: ApiError;
  loading: boolean;
  retry?: () => void;
}

/** Integration widgets: resolve the connection, fetch, and render loading / not connected / error / content. */
export function useIntegrationWidget<T extends WidgetType>(kind: IntegrationKind, type: T, integration: string | undefined, params: Record<string, unknown>) {
  const source = useSource(kind, integration);
  const q = useWidgetData(type, source.state === "ok" ? source.ref.id : null, params, source.state === "ok");
  return { source, ...q };
}

export function Gate<T>({
  kind,
  source,
  q,
  skeleton,
  subject,
  openSettings,
  children,
}: {
  kind?: IntegrationKind;
  source?: Source;
  q: Query<T>;
  skeleton: React.ReactNode;
  subject?: string;
  openSettings?: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (source?.state === "loading") return <>{skeleton}</>;
  if (kind && (source?.state === "none" || source?.state === "gone")) return <NotConnected kind={kind} gone={source.state === "gone"} />;
  const ref = source?.state === "ok" ? source.ref : undefined;
  // A stopped app can't answer: say that, instead of a network error or a stale answer.
  if (kind && ref?.appLine === "stopped") return <AppStopped kind={kind} source={ref} />;
  if (!q.data) {
    if (q.error) return <Problem error={q.error} kind={kind} subject={subject} source={ref} retry={q.retry} openSettings={openSettings} />;
    return <>{skeleton}</>;
  }
  return (
    <div className={l.fill}>
      {children(q.data)}
      <StaleNote response={q.response} error={q.error} />
    </div>
  );
}
