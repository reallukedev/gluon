"use client";
import * as React from "react";
import { Refresh, OpenNewWindow } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import type { Install, UpdateLog, UpdateMethod, UpdateRun, UpdateSettings, UpdatesStatus } from "@/lib/updates-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Panel, Notice, Skeleton } from "@/components/ui/Surface";
import { SettingRow, Switch, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import s from "./updates.module.css";

const URL = "/api/updates";

const METHOD_NAME: Record<UpdateMethod, string> = { github: "From GitHub", umbrel: "Through Umbrel", casaos: "Through CasaOS" };

function installWords(i: Install): string {
  switch (i.kind) {
    case "umbrel":
      return `Installed through Umbrel${i.storeVersion ? ` (store version ${i.storeVersion})` : ""}.`;
    case "casaos":
      return "Installed through CasaOS.";
    case "compose":
      return `Runs with Docker Compose (project ${i.project}).`;
    case "docker":
      return "Started with docker run.";
    case "development":
      return "A development copy.";
    default:
      return "Gluon couldn't tell how it was installed.";
  }
}

const STEPS = [
  { key: "download", label: "Download", description: "Fetch the new version" },
  { key: "build", label: "Build", description: "Build it on this server" },
  { key: "apply", label: "Restart", description: "Swap it in" },
  { key: "verify", label: "Back online", description: "Check it came up healthy" },
];
const STORE_STEPS = [
  { key: "apply", label: "Update", description: "The store installs it" },
  { key: "verify", label: "Back online", description: "Gluon starts again" },
];

export function Updates() {
  const { data, error, mutate } = useApi<UpdatesStatus>(URL, { refresh: 60_000 });
  const [checking, setChecking] = React.useState(false);

  async function checkNow() {
    setChecking(true);
    try {
      const fresh = await api.post<UpdatesStatus>(`${URL}/check`, {});
      await mutate(fresh, { revalidate: false });
      if (fresh.checkError) toast.error("Couldn't check for updates", { description: fresh.checkError });
      else toast.success(fresh.updateAvailable ? `Gluon ${fresh.latest?.version} is available` : "You're on the newest version");
    } catch (e) {
      toast.error("Couldn't check for updates", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setChecking(false);
    }
  }

  if (error && !data) {
    return (
      <Notice tone="fault" title="Couldn't read the update status" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
        {error.message}
      </Notice>
    );
  }
  if (!data) {
    return (
      <div className={s.stack}>
        <Skeleton height={188} radius={12} />
        <Skeleton height={220} radius={12} />
      </div>
    );
  }
  return (
    <div className={s.stack}>
      <Running data={data} checking={checking} onCheck={checkNow} />
      {data.current ? <Progress run={data.current} onDone={() => void mutate()} /> : <Available data={data} onStarted={() => void mutate()} />}
      <Automatic data={data} onSaved={(v) => void mutate({ ...data, settings: v }, { revalidate: true })} />
      {data.recent.length > 0 && <History runs={data.recent} />}
    </div>
  );
}

// ---------------------------------------------------------------- what's running, drawn on a rail

function Running({ data, checking, onCheck }: { data: UpdatesStatus; checking: boolean; onCheck: () => void }) {
  const fmt = useFormat();
  const { running, latest, updateAvailable } = data;
  return (
    <Panel
      title="This copy"
      meta={
        data.checkedAt ? (
          <span>
            Checked <Time ts={data.checkedAt} />
          </span>
        ) : undefined
      }
    >
      <div className={s.head}>
        <div>
          <div className={s.version}>
            <span className="num">{running.version}</span>
            {running.commit && <span className={`mono ${s.commit}`}>{running.commit.slice(0, 7)}</span>}
          </div>
          <p className={s.sub}>
            {installWords(data.install)} Running since <Time ts={running.startedAt} kind="dateTime" />.
          </p>
        </div>
        <Button icon={<Refresh />} onClick={onCheck} loading={checking}>
          Check now
        </Button>
      </div>

      <div className={s.rail} role="img" aria-label={updateAvailable && latest ? `Running ${running.version}; ${latest.version} is available.` : `Running ${running.version}, the newest version.`}>
        <span className={s.track} aria-hidden />
        <span className={s.mark} data-at="now" aria-hidden>
          <StateLine state="running" size={22} />
          <span className={s.markLabel}>
            <b className="num">{running.version}</b>
            <span>Running</span>
          </span>
        </span>
        {updateAvailable && latest ? (
          <>
            <span className={s.gap} aria-hidden />
            <span className={s.mark} data-at="next" aria-hidden>
              <StateLine state="starting" size={22} />
              <span className={s.markLabel}>
                <b className="num">{latest.version}</b>
                <span>{fmt.relative(latest.publishedAt)}</span>
              </span>
            </span>
          </>
        ) : (
          <span className={s.railNote}>{data.checkError ?? (latest ? "You're on the newest version." : "Not checked yet.")}</span>
        )}
      </div>
      <p className={s.fine}>
        Updates come from <a href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">github.com/{data.repo}</a>
        {data.settings.channel === "main" ? ", following every change on main." : ", following tagged releases."}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------- what's available and how to get it

function Available({ data, onStarted }: { data: UpdatesStatus; onStarted: () => void }) {
  const usable = data.options.filter((o) => o.available);
  const [method, setMethod] = React.useState<UpdateMethod | null>(null);
  const [busy, setBusy] = React.useState(false);
  const chosen = usable.find((o) => o.method === method) ?? usable.find((o) => o.method === data.settings.method) ?? usable[0];

  async function start() {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.post<UpdateRun>(`${URL}/apply`, { method: chosen.method });
      toast.info("Updating Gluon", { description: "It restarts when the new version is ready. This page reconnects on its own." });
      onStarted();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth")) toast.error("The update didn't start", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  if (!usable.length) {
    const why = data.options[0]?.reason;
    if (!why || why === "You're on the newest version.") return null;
    return (
      <Notice tone="neutral" title="Gluon can't update itself here">
        {why}
      </Notice>
    );
  }
  const latest = data.latest;
  return (
    <Panel title={chosen?.method === "github" && latest ? latest.title : "An update is ready"} meta={latest ? <Time ts={latest.publishedAt} kind="date" /> : undefined}>
      {chosen?.method === "github" && latest?.notes ? (
        <Disclosure summary="What's new" defaultOpen>
          <div className={s.notes}>{latest.notes}</div>
        </Disclosure>
      ) : null}
      {usable.length > 1 && (
        <div className={s.methods} role="radiogroup" aria-label="How to update">
          {usable.map((o) => (
            <button key={o.method} type="button" role="radio" aria-checked={chosen?.method === o.method} className={s.method} data-on={chosen?.method === o.method ? "" : undefined} onClick={() => setMethod(o.method)}>
              <b>{METHOD_NAME[o.method]}</b>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
      {usable.length === 1 && chosen && <p className={s.sub}>{chosen.label}</p>}
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void start()} loading={busy}>
          Update to {chosen?.method === "github" ? chosen.target?.version : (chosen?.storeVersion ?? "the newest version")}
        </Button>
        {latest && chosen?.method === "github" && (
          <a className={s.link} href={latest.url} target="_blank" rel="noreferrer">
            On GitHub <OpenNewWindow width={14} height={14} />
          </a>
        )}
      </div>
      <p className={s.fine}>Gluon keeps running while the new version builds, then restarts. If the new version doesn&apos;t come up healthy, the previous one is put back.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- an update in progress

function Progress({ run, onDone }: { run: UpdateRun; onDone: () => void }) {
  const [log, setLog] = React.useState<UpdateLog | null>(null);
  const [offline, setOffline] = React.useState(false);
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const l = await api.get<UpdateLog>(`${URL}/runs/${run.id}`);
        if (stop) return;
        setOffline(false);
        setLog(l);
        if (l.run.outcome !== "running" && !doneRef.current) {
          doneRef.current = true;
          if (l.run.outcome === "ok") {
            toast.success("Gluon is up to date", { description: l.run.message ?? undefined });
            setTimeout(() => window.location.reload(), 1200);
          } else toast.error("The update didn't finish", { description: l.run.message ?? undefined });
          onDone();
        }
      } catch {
        // Gluon is restarting: keep trying until the new one answers.
        if (!stop) setOffline(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [run.id, onDone]);

  const r = log?.run ?? run;
  const steps = r.method === "github" || r.method === "casaos" ? STEPS : STORE_STEPS;
  const stage = offline ? "apply" : (r.stage ?? steps[0]!.key);
  return (
    <Panel title={`Updating to ${r.toVersion}`} meta={<span>Started <Time ts={r.startedAt} /></span>}>
      <FlowSteps label="Update progress" steps={steps} current={stage} working={r.outcome === "running"} failed={r.outcome === "failed"} complete={r.outcome === "ok"} />
      <p className={s.status} aria-live="polite">
        {offline
          ? "Gluon is restarting. This page reconnects when it's back."
          : r.outcome === "failed"
            ? r.message
            : r.outcome === "ok"
              ? r.message
              : stage === "build"
                ? "Building the new version. Gluon keeps working meanwhile; this takes a few minutes."
                : "Working on it…"}
      </p>
      {log && log.lines.length > 0 && (
        <Disclosure summary="Show the output" meta={`${log.lines.length} lines`} variant="panel">
          <pre className={s.log}>{log.lines.slice(-200).join("\n")}</pre>
        </Disclosure>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- automatic updates

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

function Automatic({ data, onSaved }: { data: UpdatesStatus; onSaved: (v: UpdateSettings) => void }) {
  const [busy, setBusy] = React.useState(false);
  const methods = data.options.filter((o) => o.method === "github" || o.reason !== "Umbrel's app store doesn't list Gluon.").map((o) => o.method);

  async function save(next: Partial<UpdateSettings>) {
    const v = { ...data.settings, ...next };
    setBusy(true);
    try {
      const saved = await api.put<UpdateSettings>(`${URL}/settings`, v);
      onSaved(saved);
      if (next.auto !== undefined) toast.success(next.auto ? "Automatic updates are on" : "Automatic updates are off");
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth")) toast.error("Couldn't save", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const st = data.settings;
  return (
    <Panel title="Automatic updates" flush>
      <div className={s.rows}>
        <SettingRow label="Install updates automatically" description={st.auto ? `Checked every half hour; installs around ${hourLabel(st.hour)}, at most once a day.` : "Off. Gluon tells you when an update is available."}>
          <Switch checked={st.auto} onChange={(v) => void save({ auto: v })} disabled={busy} aria-label="Install updates automatically" />
        </SettingRow>
        <SettingRow label="When" description="The hour an automatic update may start. Pick a time nobody's watching a film.">
          <Select
            value={String(st.hour)}
            onChange={(v) => void save({ hour: Number(v) })}
            options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `Around ${hourLabel(h)}` }))}
            disabled={busy}
            aria-label="Hour for automatic updates"
          />
        </SettingRow>
        <SettingRow label="Follow" description={st.channel === "main" ? "Every change pushed to main, as soon as it lands. Newest, least tested." : "Tagged releases only. Recommended."}>
          <Segmented
            value={st.channel}
            onChange={(v) => void save({ channel: v })}
            options={[
              { value: "releases", label: "Releases" },
              { value: "main", label: "Every change" },
            ]}
            disabled={busy}
            aria-label="Which updates to follow"
          />
        </SettingRow>
        {methods.length > 1 && (
          <SettingRow label="Update from" description="Where automatic updates come from.">
            <Segmented value={st.method} onChange={(v) => void save({ method: v })} options={methods.map((m) => ({ value: m, label: METHOD_NAME[m] }))} disabled={busy} aria-label="Where updates come from" />
          </SettingRow>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- history

function History({ runs }: { runs: UpdateRun[] }) {
  return (
    <Panel title="Earlier updates" flush>
      <ul className={s.history}>
        {runs.map((r) => (
          <li key={r.id}>
            <StateLine state={r.outcome === "ok" ? "running" : r.outcome === "failed" ? "unhealthy" : "starting"} />
            <span className={s.histMain}>
              <b>
                {r.fromVersion} → {r.toVersion}
              </b>
              <span>
                {METHOD_NAME[r.method]} · {r.auto ? "automatic" : (r.username ?? "someone")}
                {r.outcome === "failed" && r.message ? ` · ${r.message}` : ""}
              </span>
            </span>
            <Time ts={r.startedAt} className={s.histTime} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
