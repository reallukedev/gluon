"use client";
import type { ManagePlan, VoiceDetails, VoiceLive } from "@/server/voice/types";
import { useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { JobProgress } from "@/components/builder/JobProgress";
import { people, useVoiceJob, voiceUrl } from "./client";
import s from "./voice.module.css";

const PROBLEM_TITLE: Record<string, string> = {
  not_managed: "Gluon can't manage this voice server yet",
  unreachable: "Gluon can't reach Mumble's admin connection",
  wrong_secret: "Mumble refused Gluon's secret",
  booting: "Mumble is still starting",
  no_server: "None of Mumble's servers is started",
};

/** What Gluon can tell before it manages the server, and the one change that lets it. */
export function NotManaged({ live, details, onManage, onRetry }: { live: VoiceLive; details: VoiceDetails | null; onManage: () => void; onRetry: () => void }) {
  const p = live.problem;
  const code = p?.code ?? "not_managed";
  const fixable = live.manage.ok && code !== "booting";
  const why =
    code === "not_managed"
      ? "Mumble's admin connection (Ice) only listens inside its container, so Gluon can't see who's here or change channels and settings. One change opens it to this server only."
      : code === "booting"
        ? "This page fills in as soon as it answers."
        : code === "wrong_secret"
          ? `${p?.message ?? ""} Let Gluon set new secrets to take it back.`
          : `${p?.message ?? ""} If it stays like this, let Gluon set it up again.`;
  const welcome = details?.settings.find((x) => x.key === "welcometext");
  const ports = live.container?.ports.filter((x) => x.container !== 6502) ?? [];

  return (
    <>
      <Notice
        tone={code === "booting" ? "neutral" : code === "not_managed" ? "neutral" : "attention"}
        title={PROBLEM_TITLE[code] ?? PROBLEM_TITLE.not_managed}
        action={
          fixable ? (
            <Button variant={code === "not_managed" ? "primary" : "secondary"} size="sm" onClick={onManage}>
              {code === "not_managed" ? "Let Gluon manage it" : "Set it up again"}
            </Button>
          ) : code === "booting" ? (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Check again
            </Button>
          ) : undefined
        }
      >
        {why}
        {!live.manage.ok && live.manage.why ? ` ${live.manage.why}` : ""}
      </Notice>

      <Panel title="What Gluon can tell from outside">
        <dl className={s.facts2}>
          <dt>Connected now</dt>
          <dd>{live.basics.connected === null ? "Gluon couldn't count" : live.basics.connected === 0 ? "Nobody" : people(live.basics.connected)}</dd>
          <dt>Ports</dt>
          <dd className={s.mono}>{ports.length ? ports.map((x) => `${x.host}${x.proto === "udp" ? "/udp" : ""}`).filter((v, i, a) => a.indexOf(v) === i).join(", ") : "None published"}</dd>
          <dt>Join password</dt>
          <dd>{live.basics.passwordSet ? (live.manage.via === "builder" ? "Set in the app's builder settings" : "Set in the compose file") : "None"}</dd>
          <dt>Room for</dt>
          <dd>{live.basics.maxUsers ? `${live.basics.maxUsers.toLocaleString()} people at once` : "Mumble's default"}</dd>
          <dt>Welcome message</dt>
          <dd>{live.basics.welcome ? live.basics.welcome : welcome === undefined && !details ? <Skeleton width={200} /> : "Mumble's default"}</dd>
          {live.container && (
            <>
              <dt>Image</dt>
              <dd className={s.mono}>{live.container.image}</dd>
            </>
          )}
        </dl>
      </Panel>
    </>
  );
}

/** Explain the change, say who it drops, run it, and show how it went. */
export function ManageDialog({ open, onOpenChange, appId, appName, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; appName: string; onDone: () => void }) {
  const plan = useApi<ManagePlan>(open ? voiceUrl(appId, "/manage") : null, { refresh: 0, revalidateOnFocus: false });
  const job = useVoiceJob(onDone);
  const started = !!job.view || job.running;
  const p = plan.data;

  const close = (o: boolean) => {
    if (o || job.running) return;
    onOpenChange(false);
    job.reset();
  };

  const drop = p ? (p.connected === null ? "Anyone connected drops for a few seconds while it restarts." : p.connected === 0 ? "Nobody is connected right now, so nobody notices the restart." : `${people(p.connected)} connected right now ${p.connected === 1 ? "drops" : "drop"} for a few seconds while it restarts, then reconnect${p.connected === 1 ? "s" : ""} on their own.`) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={started ? `Letting Gluon manage ${appName}` : `Let Gluon manage ${appName}?`}
      description={started ? undefined : "A one-time change to how it runs. After it, this tab shows who's here and changes channels, people and settings live."}
      footer={
        started ? (
          <Button variant={job.running ? "ghost" : "primary"} disabled={job.running} onClick={() => close(false)}>
            {job.running ? "Working…" : "Done"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!p?.ok} onClick={() => void job.start(voiceUrl(appId, "/manage"))}>
              Change and restart
            </Button>
          </>
        )
      }
    >
      {started ? (
        job.view ? (
          <JobProgress view={job.view} stages={job.view.stages} running={job.running} label="Letting Gluon manage the voice server" />
        ) : null
      ) : plan.error ? (
        <p role="alert">{plan.error.message}</p>
      ) : !p ? (
        <div className={s.dialogStack} aria-busy="true">
          <Skeleton height={16} />
          <Skeleton height={16} width="80%" />
          <Skeleton height={16} width="60%" />
        </div>
      ) : !p.ok ? (
        <p>{p.why}</p>
      ) : (
        <div className={s.dialogStack}>
          <ul className={s.changes}>
            {p.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
            <li>
              {p.via === "builder" ? `Gluon saves this in ${appName}'s builder settings and publishes it again.` : `Gluon backs up the compose file, edits it and applies it. If Mumble doesn't start, the old file goes back.`}
            </li>
            <li>
              <b>{drop}</b>
            </li>
          </ul>
          {p.warnings.map((w) => (
            <Notice key={w} tone="attention">
              {w}
            </Notice>
          ))}
        </div>
      )}
      {job.error && <p role="alert">{job.error}</p>}
    </Dialog>
  );
}
