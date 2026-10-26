"use client";
import * as React from "react";
import { linkTarget } from "@/lib/client/open-link";
import { mutate } from "swr";
import { ArrowUpRight, Play } from "iconoir-react";
import type { SettingsProps, WidgetProps } from "../types";
import { useSmartUrl, type HomeApp } from "./core";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine, lineLabel } from "@/components/ui/StateLine";
import { Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { instanceHints, shortName } from "@/lib/app-names";
import { SetUp, WidgetState } from "./kit";
import s from "./app.module.css";

export interface AppConfig {
  appId?: string;
  /** The app's name when it was picked, so edit mode can say which tile this is. */
  name?: string;
}

/** What /api/apps returns: admins get containers (for live stats); members get the trimmed view. */
export type ApiApp = HomeApp & {
  source?: string;
  containers?: { name: string; state: string; status: string }[];
};

const HOST = /^https?:\/\/([^/]+)/i;
export const hostOf = (u: string | null) => (u ? (HOST.exec(u)?.[1] ?? u) : null);

/** Which copy each app is, worked out once per /api/apps answer rather than once per card showing it. */
const hintsCache = new WeakMap<ApiApp[], Map<string, string | null>>();
export function appHints(apps: ApiApp[]) {
  let hints = hintsCache.get(apps);
  if (!hints) hintsCache.set(apps, (hints = instanceHints(apps)));
  return hints;
}

/** Docker's "Up 3 days (healthy)" → "3 days". */
export function uptimeOf(app: ApiApp): string | null {
  const c = app.containers?.find((x) => x.state === "running");
  const m = c ? /^Up\s+(.+?)(\s*\(.*\))?$/i.exec(c.status) : null;
  if (!m) return null;
  return m[1]!.replace(/^About an? /i, "1 ").replace(/^Less than a second$/i, "a moment");
}

/** CPU (% of the machine) and memory for an app's containers over the live window. */
function useAppSeries(names: string[]) {
  const { containers } = useLive();
  const key = names.join("\u0000");
  return React.useMemo(() => {
    const set = new Set(key.split("\u0000"));
    const out: { t: number; cpu: number; mem: number }[] = [];
    for (const sample of containers) {
      let cpu = 0;
      let mem = 0;
      let seen = false;
      for (const c of sample.list) {
        if (!set.has(c.name)) continue;
        cpu += c.cpu;
        mem += c.mem;
        seen = true;
      }
      if (seen) out.push({ t: sample.t, cpu, mem });
    }
    return out;
  }, [containers, key]);
}

/** A 1.25px line over the live window, ending in a marked "now". Pure SVG, no axes: the figure above it says the value. */
function Trace({ values, max, label }: { values: number[]; max: number; label: string }) {
  const h = 24;
  if (values.length < 2) return <span className={s.traceEmpty} aria-hidden />;
  const top = Math.max(max, 1e-9);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(2)},${(h - 1 - (Math.min(v, top) / top) * (h - 3)).toFixed(2)}`).join("");
  return (
    <svg className={s.trace} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={d} className={s.traceLine} vectorEffect="non-scaling-stroke" />
      <line x1="99.6" x2="99.6" y1="0" y2={h} className={s.traceNow} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Vitals({ app, name }: { app: ApiApp; name: string }) {
  const fmt = useFormat();
  const series = useAppSeries((app.containers ?? []).map((c) => c.name));
  const last = series.at(-1);
  if (!last) {
    return (
      <div className={s.vitals} aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className={s.vital}>
            <Skeleton width={36} height={9} />
            <Skeleton width={52} height={20} />
            <Skeleton height={20} />
          </div>
        ))}
      </div>
    );
  }
  const cpuMax = Math.max(5, ...series.map((p) => p.cpu)) * 1.15;
  const memMax = Math.max(...series.map((p) => p.mem)) * 1.15;
  const [memValue, memUnit] = fmt.bytes(last.mem).split(" ");
  return (
    <div className={s.vitals}>
      <div className={s.vital}>
        <span className="label">CPU</span>
        <span className={s.figure}>
          {last.cpu < 0.05 ? "0" : last.cpu < 10 ? last.cpu.toFixed(1) : Math.round(last.cpu)}
          <small>%</small>
        </span>
        <Trace values={series.map((p) => p.cpu)} max={cpuMax} label={`${name} CPU over the last ${Math.max(1, Math.round((last.t - series[0]!.t) / 60_000))} minutes`} />
      </div>
      <div className={s.vital}>
        <span className="label">Memory</span>
        <span className={s.figure}>
          {memValue}
          <small> {memUnit}</small>
        </span>
        <Trace values={series.map((p) => p.mem)} max={memMax} label={`${name} memory over the last ${Math.max(1, Math.round((last.t - series[0]!.t) / 60_000))} minutes`} />
      </div>
    </div>
  );
}

export function AppWidget({ item, size, openSettings }: WidgetProps<AppConfig>) {
  const { data, error } = useApi<ApiApp[]>("/api/apps", { refresh: 20_000 });
  const { viewer, prefs, serverName } = usePrefs();
  const url = useSmartUrl();
  const [starting, setStarting] = React.useState(false);
  const appId = item.config.appId;
  const admin = viewer.role === "admin";

  if (!appId) {
    return (
      <WidgetState title="Which app?" action={<SetUp openSettings={openSettings}>Pick an app</SetUp>}>
        This tile shows one app: whether it&apos;s running, and a button to open it.
      </WidgetState>
    );
  }
  if (!data) {
    if (error) {
      return (
        <WidgetState line="unknown" title="Can't load your apps">
          {admin ? error.message : "Gluon didn't answer just now. It tries again on its own."}
        </WidgetState>
      );
    }
    return (
      <div className={s.app} data-size={size} aria-busy="true">
        <div className={s.head}>
          <Skeleton width={36} height={36} radius={9} />
          <div className={s.headText}>
            <Skeleton width="60%" height={14} />
            <Skeleton width="40%" height={11} />
          </div>
        </div>
      </div>
    );
  }
  const app = data.find((a) => a.id === appId);
  if (!app) {
    return (
      <WidgetState title={item.config.name ? `${item.config.name} is gone` : "This app is gone"} action={<SetUp openSettings={openSettings}>Pick another app</SetUp>}>
        {admin ? "It was removed from the server. Pick another app, or remove this tile." : "It was removed or isn't shared with you any more."}
      </WidgetState>
    );
  }
  const hint = appHints(data).get(app.id);
  const href = url(app.urls);
  const target = linkTarget(href, prefs.openLinks === "new");
  const stopped = app.line === "stopped";
  const hasStats = admin && !stopped && !!app.containers?.length;
  const uptime = !stopped ? uptimeOf(app) : null;
  const publicHost = hostOf(app.urls.away);
  const homeHost = hostOf(app.urls.home);

  async function start() {
    setStarting(true);
    try {
      await api.post(`/api/apps/${encodeURIComponent(app!.id)}/action`, {
        action: "start",
      });
      toast.success(`Starting ${app!.name}`);
      await mutate("/api/apps");
    } catch (e) {
      toast.error(`Couldn't start ${app!.name}`, {
        description: e instanceof ApiError ? e.message : undefined,
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={s.app} data-size={size} data-stopped={stopped ? "" : undefined}>
      <div className={s.head}>
        <span className={s.icon}>
          <AppIcon src={app.icon} name={app.name} size={36} />
        </span>
        <div className={s.headText}>
          <span className={s.name} title={hint ? `${app.name} · ${hint}` : app.name}>
            {shortName(app.name, serverName)}
            {hint && <span className={s.hint}>{hint}</span>}
          </span>
          <span className={s.stateRow}>
            <StateLine state={app.line} size={11} />
            <span>{app.line === "running" ? (uptime ? `Up ${uptime}` : "Running") : app.line === "unhealthy" || app.line === "attention" ? app.summary : lineLabel(app.line)}</span>
          </span>
        </div>
        {href && (
          <a className={s.open} href={href} target={target} rel="noopener noreferrer" aria-label={`Open ${app.name}`} title={`Open ${app.name}`}>
            <ArrowUpRight />
          </a>
        )}
      </div>

      {stopped ? (
        <div className={s.stoppedBody}>
          <p>{admin ? `${app.name} is stopped, so it can't be opened.` : `${app.name} is stopped right now. Whoever runs the server can start it.`}</p>
          {admin && (
            <Button size="sm" icon={<Play />} loading={starting} onClick={() => void start()}>
              Start {app.name}
            </Button>
          )}
        </div>
      ) : hasStats ? (
        <Vitals app={app} name={app.name} />
      ) : (
        size !== "s" && app.description && <p className={s.description}>{app.description}</p>
      )}

      {(size === "t" || size === "m") && (homeHost || publicHost) && (
        <dl className={s.addresses}>
          {homeHost && (
            <div>
              <dt>At home</dt>
              <dd className="mono truncate" title={app.urls.home ?? undefined}>
                {homeHost}
              </dd>
            </div>
          )}
          {publicHost && (
            <div>
              <dt>Anywhere</dt>
              <dd className="mono truncate" title={app.urls.away ?? undefined}>
                {publicHost}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

export function AppSettings({ config, onChange }: SettingsProps<AppConfig>) {
  const { data } = useApi<ApiApp[]>("/api/apps");
  if (!data) return <Skeleton height={34} />;
  const hints = instanceHints(data);
  return (
    <Field label="App">
      <Select
        aria-label="App"
        value={config.appId ?? ""}
        onChange={(v) => onChange({ ...config, appId: v || undefined, name: data.find((a) => a.id === v)?.name })}
        options={[...data]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((a) => ({
            value: a.id,
            label: hints.get(a.id) ? `${a.name} · ${hints.get(a.id)}` : a.name,
          }))}
      />
    </Field>
  );
}

/** Catalog preview for the App tile: the same miniature tile as every other preview, with the app's real icon. */
export function AppPreview({ icon, name }: { icon?: string | null; name?: string }) {
  return (
    <span className={s.preview}>
      <span className={s.previewHead}>
        <AppIcon src={icon ?? null} name={name ?? "App"} size={18} />
        <span className={s.previewWords}>
          <i />
          <i />
        </span>
      </span>
      <svg viewBox="0 0 96 14" aria-hidden>
        <polyline points="0,10 10,9.5 20,10 30,6.5 40,7.5 50,4 60,6 70,5 80,7 96,6" />
        <line x1="95.5" x2="95.5" y1="0" y2="14" />
      </svg>
    </span>
  );
}
