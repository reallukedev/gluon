"use client";
import * as React from "react";
import { Markdown } from "@/components/files/Markdown";
import { Refresh, OpenNewWindow } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import {
  CHANNEL_NAME,
  baseVersion,
  type Install,
  type UpdateChannel,
  type UpdateLog,
  type UpdateMethod,
  type UpdateRun,
  type UpdateSettings,
  type UpdatesStatus,
} from "@/lib/updates-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Panel, Notice, Skeleton } from "@/components/ui/Surface";
import { SettingRow, Switch, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import { useConfirm, type ConfirmOptions } from "@/components/ui/Dialog";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import s from "./updates.module.css";

const URL = "/api/updates";

const METHOD_NAME: Record<UpdateMethod, string> = { github: "From GitHub", umbrel: "Through Umbrel", casaos: "Through CasaOS" };

const CHANNELS: { value: UpdateChannel; line: string }[] = [
  { value: "stable", line: "Tested releases, a few times a month." },
  { value: "nightly", line: "Every change as it's made. Newest features, occasional rough edges." },
];

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

/** "Gluon 1.2.0" / "Nightly 1.3.0-nightly.20260928.1a2b3c4". */
function buildName(d: UpdatesStatus): string {
  if (!d.latest) return "A newer Gluon";
  return d.latest.channel === "nightly" ? `${CHANNEL_NAME.nightly} ${d.latest.version}` : `Gluon ${d.latest.version}`;
}

function errorText(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}
const cancelledReauth = (e: unknown) => e instanceof ApiError && e.code === "reauth";

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
  const [confirm, confirmNode] = useConfirm();

  const apply = React.useCallback((fresh: UpdatesStatus) => void mutate(fresh, { revalidate: false }), [mutate]);

  async function checkNow() {
    setChecking(true);
    try {
      const fresh = await api.post<UpdatesStatus>(`${URL}/check`, {});
      apply(fresh);
      if (fresh.checkError) toast.error("Couldn't check for updates", { description: fresh.checkError });
      else if (fresh.updateAvailable) toast.success(`${buildName(fresh)} is available`);
      else if (fresh.relation === "ahead") toast.success(`You're ahead of ${fresh.latest?.version}, the newest release`);
      else toast.success(fresh.settings.channel === "nightly" ? "You're on the newest nightly" : "You're on the newest version");
    } catch (e) {
      toast.error("Couldn't check for updates", { description: errorText(e) });
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
        <Skeleton height={140} radius={12} />
        <Skeleton height={220} radius={12} />
      </div>
    );
  }
  return (
    <div className={s.stack}>
      <Running data={data} checking={checking} onCheck={() => void checkNow()} />
      <Situation data={data} checking={checking} onCheck={() => void checkNow()} onChanged={() => void mutate()} confirm={confirm} />
      <Channel data={data} onSaved={apply} setChecking={setChecking} />
      <Automatic data={data} onSaved={apply} />
      {data.recent.length > 0 && <History runs={data.recent} />}
      {confirmNode}
    </div>
  );
}

// ---------------------------------------------------------------- what's running, drawn on a rail

function Running({ data, checking, onCheck }: { data: UpdatesStatus; checking: boolean; onCheck: () => void }) {
  const fmt = useFormat();
  const { running, latest, updateAvailable, relation } = data;
  const nightly = data.settings.channel === "nightly";
  const note = checking
    ? `Checking ${CHANNEL_NAME[data.settings.channel]}…`
    : data.checkError
      ? "Couldn't check."
      : !latest
        ? "Not checked yet."
        : relation === "ahead"
          ? `Ahead of ${latest.version}, the newest release.`
          : nightly
            ? "You're on the newest nightly."
            : "You're on the newest version.";
  return (
    <Panel
      title="This copy"
      meta={
        checking ? (
          <span>Checking…</span>
        ) : data.checkedAt ? (
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
            {running.commit && (
              <a className={`mono ${s.commit}`} href={`https://github.com/${data.repo}/commit/${running.commit}`} target="_blank" rel="noreferrer" title="This build's commit on GitHub">
                {running.commit.slice(0, 7)}
              </a>
            )}
          </div>
          <p className={s.sub}>
            {CHANNEL_NAME[running.channel]} build. {installWords(data.install)} Started <Time ts={running.startedAt} />.
          </p>
        </div>
        <Button icon={<Refresh />} onClick={onCheck} loading={checking}>
          Check now
        </Button>
      </div>

      <div
        className={s.rail}
        role="img"
        aria-label={updateAvailable && latest ? `Running ${running.version}; ${latest.version} is available.` : `Running ${running.version}. ${note}`}
      >
        <span className={s.track} aria-hidden />
        <span className={s.mark} data-at="now" aria-hidden>
          <StateLine state="running" size={22} />
          <span className={s.markLabel}>
            <b className="num">{running.version}</b>
            <span>Running</span>
          </span>
        </span>
        {updateAvailable && latest && !checking ? (
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
          <span className={s.railNote}>{note}</span>
        )}
      </div>
      <p className={s.fine}>
        Updates come from{" "}
        <a href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">
          github.com/{data.repo}
        </a>
        {nightly ? ", following every change pushed to main (Nightly)." : ", following tagged releases (Stable)."}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------- what to do now: one of several states

function Situation({
  data,
  checking,
  onCheck,
  onChanged,
  confirm,
}: {
  data: UpdatesStatus;
  checking: boolean;
  onCheck: () => void;
  onChanged: () => void;
  confirm: (o: ConfirmOptions) => void;
}) {
  if (data.current) return <Progress run={data.current} onDone={onChanged} />;
  const last = data.recent[0];
  const recentFailure = last && last.outcome === "failed" && last.finishedAt && Date.now() - last.finishedAt < 24 * 3600_000 ? last : null;
  return (
    <>
      {recentFailure && <LastFailed run={recentFailure} />}
      {!data.canSelfUpdate && <CantUpdate data={data} />}
      {data.checkError && (
        <Notice
          tone="neutral"
          title="Couldn't check for updates"
          action={
            <Button size="sm" onClick={onCheck} loading={checking}>
              Retry
            </Button>
          }
        >
          {data.checkError}
        </Notice>
      )}
      {data.relation === "ahead" && data.latest && <Ahead data={data} onStarted={onChanged} confirm={confirm} />}
      <Available data={data} onStarted={onChanged} />
    </>
  );
}

function CantUpdate({ data }: { data: UpdatesStatus }) {
  const why = data.options.find((o) => o.method === "github")?.reason;
  const dev = data.install.kind === "development";
  return (
    <Notice tone="neutral" title={dev ? "Updates are off for development copies" : "Gluon can't update itself here"}>
      {why ?? "Gluon can't replace its own container here."}
      {dev && data.updateAvailable && data.latest ? ` ${buildName(data)} is out on GitHub.` : ""}
    </Notice>
  );
}

/** Stable, while running something past the newest release (usually a nightly). */
function Ahead({ data, onStarted, confirm }: { data: UpdatesStatus; onStarted: () => void; confirm: (o: ConfirmOptions) => void }) {
  const latest = data.latest!;
  const nightly = data.running.channel === "nightly";
  const base = baseVersion(data.running.version);
  const next = nightly && base && base !== "0.0.0" && base !== latest.version ? base : "the next version";
  const target = data.goBack;

  function goBack() {
    if (!target) return;
    confirm({
      title: `Go back to Gluon ${target.version}?`,
      description: `Gluon downloads ${target.version} from GitHub, builds it on this server and restarts on it. This takes a few minutes; Gluon keeps working meanwhile.`,
      consequences: [
        "Your data is kept: accounts, settings, apps, alerts and history stay as they are.",
        `Features added since ${target.version} disappear until a newer Stable release brings them back.`,
        `Settings ${target.version} doesn't know about are ignored while it runs; some, like automatic updates, may go back to their defaults.`,
        `If ${target.version} doesn't come up healthy, Gluon puts this version back.`,
      ],
      confirmLabel: `Go back to ${target.version}`,
      variant: "primary",
      onConfirm: async () => {
        try {
          await api.post<UpdateRun>(`${URL}/apply`, { method: "github", allowOlder: true });
        } catch (e) {
          if (cancelledReauth(e)) return;
          throw e;
        }
        toast.info(`Going back to ${target.version}`, { description: "Gluon restarts when it's ready. This page reconnects on its own." });
        onStarted();
      },
    });
  }

  return (
    <Notice
      tone="neutral"
      title={nightly ? `You're on a nightly build ahead of ${latest.version}.` : `You're on ${data.running.version}, ahead of ${latest.version}.`}
      action={
        target ? (
          <Button size="sm" onClick={goBack}>
            Go back to {target.version} now
          </Button>
        ) : undefined
      }
    >
      {nightly ? `Gluon will move to Stable when ${next} is released.` : "Gluon will offer updates again when a newer release comes out."}
      {target ? ` Or go back to ${target.version} now; your data is kept.` : ""}
    </Notice>
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
      if (!cancelledReauth(e)) toast.error("The update didn't start", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!usable.length || !chosen) return null;
  const latest = data.latest;
  const fromGithub = chosen.method === "github" && !!latest;
  const nightly = fromGithub && latest!.channel === "nightly";
  const since = nightly ? latest!.since : null;
  const actionLabel = fromGithub ? (nightly ? `Install nightly ${latest!.version} now` : `Update to ${latest!.version}`) : `Update to ${chosen.storeVersion ?? "the newest version"}`;

  return (
    <Panel title={fromGithub ? latest!.title : "An update is ready"} meta={fromGithub ? <Time ts={latest!.publishedAt} kind={nightly ? "relative" : "date"} /> : undefined}>
      {fromGithub && (
        <p className={s.sub}>
          {nightly ? (
            <>
              <span className="num">{latest!.version}</span>, the newest change on main
              {since ? (
                <>
                  {" "}
                  · <b className="num">{since.count}</b> {since.count === 1 ? "change" : "changes"} since yours
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Gluon <span className="num">{latest!.version}</span>, released <Time ts={latest!.publishedAt} kind="date" />.
            </>
          )}
        </p>
      )}
      {since && since.titles.length > 0 && (
        <Disclosure summary="What changed" meta={since.count > since.titles.length ? `newest ${since.titles.length} of ${since.count}` : undefined} defaultOpen={since.titles.length <= 8}>
          <ul className={s.changes}>
            {since.titles.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      {fromGithub && latest!.notes ? (
        <Disclosure summary={nightly ? "About this change" : "What's new"} defaultOpen={!nightly}>
          <div className={s.notes}>
            <Markdown source={latest!.notes} />
          </div>
        </Disclosure>
      ) : null}
      {usable.length > 1 && (
        <div className={s.methods} role="radiogroup" aria-label="How to update">
          {usable.map((o) => (
            <button
              key={o.method}
              type="button"
              role="radio"
              aria-checked={chosen.method === o.method}
              className={s.choice}
              data-on={chosen.method === o.method ? "" : undefined}
              onClick={() => setMethod(o.method)}
            >
              <b>{METHOD_NAME[o.method]}</b>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
      {usable.length === 1 && <p className={s.sub}>{chosen.label}</p>}
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void start()} loading={busy}>
          {actionLabel}
        </Button>
        {fromGithub && (
          <a className={s.link} href={latest!.url} target="_blank" rel="noreferrer">
            On GitHub <OpenNewWindow width={14} height={14} />
          </a>
        )}
      </div>
      <p className={s.fine}>Gluon keeps running while the new version builds, then restarts. If the new version doesn&apos;t come up healthy, the previous one is put back.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- an update in progress, or one that failed

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

function LastFailed({ run }: { run: UpdateRun }) {
  return (
    <Notice tone="fault" title={`The update to ${run.toVersion} didn't finish`}>
      {run.message ?? "The updater stopped without saying why."} <Time ts={run.finishedAt ?? run.startedAt} />.
      <RunOutput id={run.id} />
    </Notice>
  );
}

/** The updater's output for one run, fetched when opened. */
function RunOutput({ id }: { id: string }) {
  const [open, setOpen] = React.useState(false);
  const { data, error, isLoading } = useApi<UpdateLog>(open ? `${URL}/runs/${id}` : null);
  return (
    <Disclosure summary="Show the output" meta={data ? `${data.lines.length} lines` : undefined} open={open} onOpenChange={setOpen} className={s.output}>
      {error ? (
        <p className={s.sub}>Couldn&apos;t read the output: {error.message}</p>
      ) : isLoading || !data ? (
        <Skeleton height={80} />
      ) : data.lines.length ? (
        <pre className={s.log}>{data.lines.slice(-200).join("\n")}</pre>
      ) : (
        <p className={s.sub}>This update left no output{data.run.method === "umbrel" ? " (Umbrel ran it)" : ""}.</p>
      )}
    </Disclosure>
  );
}

// ---------------------------------------------------------------- channel

function Channel({ data, onSaved, setChecking }: { data: UpdatesStatus; onSaved: (v: UpdatesStatus) => void; setChecking: (b: boolean) => void }) {
  const [pending, setPending] = React.useState<UpdateChannel | null>(null);
  const on = data.settings.channel;

  async function choose(channel: UpdateChannel) {
    if (channel === on || pending) return;
    setPending(channel);
    setChecking(true);
    try {
      const fresh = await api.put<UpdatesStatus>(`${URL}/settings`, { ...data.settings, channel } satisfies UpdateSettings);
      onSaved(fresh);
      const name = CHANNEL_NAME[channel];
      const description = fresh.checkError
        ? `Couldn't check ${name} yet: ${fresh.checkError}`
        : fresh.updateAvailable
          ? fresh.canSelfUpdate
            ? `${buildName(fresh)} is ready to install.`
            : `${buildName(fresh)} is out on GitHub.`
          : fresh.relation === "ahead" && fresh.latest
            ? `You're ahead of ${fresh.latest.version}, the newest release.`
            : channel === "nightly"
              ? "You're on the newest nightly."
              : "You're on the newest release.";
      toast.success(`Switched to ${name}`, { description });
    } catch (e) {
      if (!cancelledReauth(e)) toast.error("Couldn't switch channel", { description: errorText(e) });
    } finally {
      setPending(null);
      setChecking(false);
    }
  }

  return (
    <Panel title="Channel">
      <div className={s.methods} role="radiogroup" aria-label="Update channel">
        {CHANNELS.map((c) => {
          const checked = (pending ?? on) === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={checked}
              className={s.choice}
              data-on={checked ? "" : undefined}
              data-busy={pending === c.value ? "" : undefined}
              disabled={!!pending}
              onClick={() => void choose(c.value)}
            >
              <b>
                {CHANNEL_NAME[c.value]}
                {c.value === "stable" && <span className={s.hint}>Recommended</span>}
              </b>
              <span>{c.line}</span>
            </button>
          );
        })}
      </div>
      <p className={s.fine}>
        {pending
          ? `Switching to ${CHANNEL_NAME[pending]} and checking what it has…`
          : on === "nightly"
            ? "Gluon looks for a new nightly every half hour. Switching back to Stable never goes backwards on its own: you choose when."
            : "Gluon looks for a new release every few hours. Switching channel checks straight away."}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------- automatic updates

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

function Automatic({ data, onSaved }: { data: UpdatesStatus; onSaved: (v: UpdatesStatus) => void }) {
  const [busy, setBusy] = React.useState(false);
  const methods = data.options.filter((o) => o.method === "github" || o.reason !== "Umbrel's app store doesn't list Gluon.").map((o) => o.method);

  async function save(next: Partial<UpdateSettings>) {
    const v: UpdateSettings = { ...data.settings, ...next };
    setBusy(true);
    try {
      const fresh = await api.put<UpdatesStatus>(`${URL}/settings`, v);
      onSaved(fresh);
      if (next.auto !== undefined) toast.success(next.auto ? "Automatic updates are on" : "Automatic updates are off");
    } catch (e) {
      if (!cancelledReauth(e)) toast.error("Couldn't save", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const st = data.settings;
  const nightly = st.channel === "nightly";
  const asap = nightly && st.nightlyTiming === "asap";
  const description = !st.auto
    ? "Off. Gluon tells you when an update is available."
    : asap
      ? "On. Each nightly is installed within about half an hour of landing, at most once every 45 minutes."
      : nightly
        ? `On. The newest nightly is installed around ${hourLabel(st.hour)}, at most once a day.`
        : `On. New releases are installed around ${hourLabel(st.hour)}, at most once a day.`;

  return (
    <Panel title="Automatic updates">
      <div className={s.rows}>
        <SettingRow label={nightly ? "Install nightlies automatically" : "Install updates automatically"} description={description}>
          <Switch checked={st.auto} onChange={(v) => void save({ auto: v })} disabled={busy} aria-label="Install updates automatically" />
        </SettingRow>
        {nightly && (
          <SettingRow
            label="How often"
            description={asap ? "Install each nightly as it lands. Never while another update is running." : `Once a day, around ${hourLabel(st.hour)}.`}
          >
            <Segmented
              value={st.nightlyTiming}
              onChange={(v) => void save({ nightlyTiming: v })}
              options={[
                { value: "asap", label: "As it lands" },
                { value: "hour", label: "Once a day" },
              ]}
              disabled={busy}
              aria-label="How often to install nightlies"
            />
          </SettingRow>
        )}
        {!asap && (
          <SettingRow label="When" description="The hour an automatic update may start. Pick a time nobody's watching a film.">
            <Select
              value={String(st.hour)}
              onChange={(v) => void save({ hour: Number(v) })}
              options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `Around ${hourLabel(h)}` }))}
              disabled={busy}
              aria-label="Hour for automatic updates"
            />
          </SettingRow>
        )}
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
            <div className={s.histRow}>
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
            </div>
            {r.outcome === "failed" && <RunOutput id={r.id} />}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
