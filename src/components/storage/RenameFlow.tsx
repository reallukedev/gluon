"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, streamPost, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Disclosure } from "@/components/ui/Disclosure";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import type { AppSummary } from "@/server/docker/apps";
import type { RenamePlan } from "@/lib/storage-types";
import { emptyRun, JobOutcome, JobSteps, reduceJob, type JobEvent, type JobRun } from "./JobProgress";
import { errorText } from "./VolumeDialogs";
import { BeforeAfter } from "./BeforeAfter";
import s from "./storage.module.css";

type Phase = "choose" | "review" | "run";

/** Put `?job=` in the address bar while a job runs, so a reload reattaches to it. */
export function useJobParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return React.useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("job", id);
      else next.delete("job");
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, params],
  );
}

/** Compact before/after lines for a small change. */
export function LineDiff({ changes }: { changes: { line: number; before: string; after: string }[] }) {
  return (
    <div className={s.diff} role="group" aria-label="Changes">
      {changes.map((c) => (
        <React.Fragment key={c.line}>
          <div className={s.diffLine} data-kind="del">
            <span className={`${s.diffNo} num`}>{c.line}</span>
            <span className={s.diffSign} aria-label="removed">−</span>
            <code>{c.before}</code>
          </div>
          <div className={s.diffLine} data-kind="add">
            <span className={`${s.diffNo} num`}>{c.line}</span>
            <span className={s.diffSign} aria-label="added">+</span>
            <code>{c.after}</code>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

export function RenameFlow({ from, onClose, onDone }: { from: string | null; onClose: () => void; onDone: () => void }) {
  const fmt = useFormat();
  const setJobParam = useJobParam();
  const [phase, setPhase] = React.useState<Phase>("choose");
  const [to, setTo] = React.useState("");
  const [symlink, setSymlink] = React.useState(false);
  const [plan, setPlan] = React.useState<RenamePlan | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<JobRun>(emptyRun);
  const [running, setRunning] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const { data: apps } = useApi<AppSummary[]>(from ? "/api/apps" : null);

  React.useEffect(() => {
    if (!from) return;
    setPhase("choose");
    setTo("");
    setSymlink(false);
    setPlan(null);
    setError(null);
    setRun(emptyRun);
  }, [from]);

  async function makePlan() {
    if (!from) return;
    setPlanning(true);
    setError(null);
    try {
      const p = await api.post<RenamePlan>("/api/storage/plan", { op: "rename", target: from, newPath: to.trim(), symlink, persist: true });
      setPlan(p);
      setPhase("review");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPlanning(false);
    }
  }

  async function execute(p: RenamePlan) {
    setPhase("run");
    setRun(emptyRun);
    setRunning(true);
    try {
      await streamPost<JobEvent>("/api/storage/operations", { op: "rename", target: p.from, newPath: p.to, symlink: p.symlink, persist: p.persist, planHash: p.hash }, (e) => {
        if (e.type === "job") setJobParam(e.job.id);
        setRun((st) => reduceJob(st, e));
        if (e.type === "done") {
          if (e.ok) toast.success(e.message);
          onDone();
        }
      });
    } catch (e) {
      const msg = errorText(e);
      if (msg === null) {
        setPhase("review");
      } else {
        setRun((st) => reduceJob(st, { type: "error", message: msg }));
      }
    } finally {
      setRunning(false);
    }
  }

  function askToRun(p: RenamePlan) {
    const stopping = p.apps.filter((a) => a.willStop);
    confirm({
      title: `Move ${p.from} to ${p.to}?`,
      consequences: [
        stopping.length ? `${fmt.plural(stopping.length, "app")} (${stopping.map((a) => a.name).join(", ")}) stop for a minute or two, then start again.` : "No apps need to stop.",
        `The drive is unmounted and mounted again at ${p.to}.`,
        ...(p.files.some((f) => f.changes.length) ? [`${fmt.plural(p.files.filter((f) => f.changes.length).length, "file")} ${p.files.filter((f) => f.changes.length).length === 1 ? "is" : "are"} updated; each keeps a backup next to it.`] : []),
        p.fstab.action !== "none" ? "/etc/fstab is updated (a backup is kept)." : "/etc/fstab doesn't change.",
        p.symlink ? `${p.from} keeps working as a link to ${p.to}.` : `${p.from} stops existing. Anything still using it by name will break.`,
        "If any step fails, Gluon puts everything back the way it was.",
      ],
      confirmLabel: "Move it",
      variant: "primary",
      onConfirm: () => void execute(p),
    });
  }

  const close = () => {
    if (running) return;
    if (run.job) setJobParam(null);
    onClose();
  };

  const appIcon = (id: string, name: string) => <AppIcon src={apps?.find((a) => a.id === id)?.icon} name={name} size={28} />;
  const changedFiles = plan?.files.filter((f) => f.changes.length) ?? [];

  let footer: React.ReactNode;
  if (phase === "choose") {
    footer = (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" loading={planning} disabled={!to.trim().startsWith("/") || to.trim() === from} onClick={() => void makePlan()}>
          Check what changes
        </Button>
      </>
    );
  } else if (phase === "review" && plan) {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setPhase("choose")}>
          Back
        </Button>
        <Button variant="primary" disabled={plan.blockers.length > 0} onClick={() => askToRun(plan)}>
          Move to {plan.to}
        </Button>
      </>
    );
  } else {
    footer = (
      <Button variant={running ? "ghost" : "primary"} disabled={running} onClick={close}>
        {running ? "Working…" : "Close"}
      </Button>
    );
  }

  return (
    <>
      <Dialog
        open={!!from}
        onOpenChange={(o) => !o && close()}
        title={phase === "run" ? `Moving ${from} to ${plan?.to ?? to}` : `Rename ${from ?? ""}`}
        description={phase === "choose" ? "Give the drive's folder a new name. Gluon finds every app that uses it, updates their settings, restarts them, and shows you every change before it makes it." : undefined}
        size="xwide"
        footer={footer}
      >
        <div className={s.flowHead}>
          <FlowSteps
            label="Rename a mount point"
            steps={[
              { key: "choose", label: "New place" },
              { key: "review", label: "Check what changes" },
              { key: "run", label: "Move" },
            ]}
            current={phase}
            working={running}
            failed={!!run.result && !run.result.ok}
            complete={!!run.result?.ok}
          />
        </div>
        <div className={`${s.phaseBody} appear`} key={phase}>
        {phase === "choose" && (
          <div className={s.stack}>
            <Field label="New place" description="A new or empty folder, for example /mnt/photos. Letters, numbers, dots, dashes and underscores.">
              <Input
                mono
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="/mnt/photos"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && to.trim().startsWith("/")) void makePlan();
                }}
              />
            </Field>
            <SettingRow
              label={`Leave a link at ${from}`}
              description={`Anything that still uses ${from} (a script, an app Gluon can't edit) keeps working, because the old path points to the new one. Turn it off for a clean move.`}
            >
              <Switch checked={symlink} onChange={setSymlink} aria-label="Leave a compatibility link" />
            </SettingRow>
            {error && <Notice tone="fault">{error}</Notice>}
          </div>
        )}

        {phase === "review" && plan && (
          <div className={s.stack}>
            <BeforeAfter
              before={{
                state: "running",
                text: (
                  <>
                    The {plan.diskTitle}&apos;s files are at <span className="mono">{plan.from}</span>
                  </>
                ),
                detail: plan.apps.length ? `${fmt.plural(plan.apps.length, "app")} use this path` : "No app uses it",
              }}
              after={{
                state: "running",
                text: (
                  <>
                    They&apos;re at <span className="mono">{plan.to}</span>
                    {plan.symlink ? <>, and <span className="mono">{plan.from}</span> still leads there</> : null}
                  </>
                ),
                detail: plan.apps.length ? `Their settings point to the new place; ${plan.apps.some((a) => a.willStop) ? "running ones restart once" : "none need to restart"}` : "Nothing else changes",
              }}
            />
            {plan.blockers.length > 0 && (
              <Notice tone="fault" title="This can't be done yet">
                <ul className={s.plainList}>
                  {plan.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {plan.warnings.length > 0 && (
              <Notice tone="attention">
                <ul className={s.plainList}>
                  {plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}

            <section className={s.planSection}>
              <h3 className={s.planTitle}>Apps</h3>
              {plan.apps.length === 0 ? (
                <p className={s.muted}>No app uses {plan.from}, so nothing needs to stop.</p>
              ) : (
                <ul className={s.planApps} role="list">
                  {plan.apps.map((a) => (
                    <li key={a.id}>
                      {appIcon(a.id, a.name)}
                      <div className={s.planAppText}>
                        <span className={s.planAppName}>{a.name}</span>
                        <span className={s.muted}>
                          {a.willStop ? `Stops, then starts again${a.restartServices.length > 1 ? ` (${a.restartServices.join(", ")})` : ""}` : "Not running; its settings are updated"}
                          {a.mode === "containers" ? " · keeps using the old path through the link" : ""}
                        </span>
                        <span className={s.planPaths}>
                          {[...new Set(a.containers.flatMap((c) => c.paths.map((p) => p.source)))].slice(0, 3).map((src) => (
                            <span key={src} className="mono" title={src}>
                              {src}
                            </span>
                          ))}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={s.planSection}>
              <h3 className={s.planTitle}>Files that change</h3>
              {changedFiles.length === 0 ? (
                <p className={s.muted}>No compose files mention {plan.from}.</p>
              ) : (
                changedFiles.map((f) => (
                  <div key={f.path} className={s.planFile}>
                    <p className={s.planFileHead}>
                      <span className="mono truncate" title={f.path}>
                        {f.path}
                      </span>
                      <span className={s.muted}>{f.apps.join(", ")}</span>
                    </p>
                    <LineDiff changes={f.changes} />
                  </div>
                ))
              )}
              {plan.files.some((f) => f.untouched.length) && (
                <Disclosure summary="Other mentions Gluon leaves alone" meta={plan.files.reduce((n, f) => n + f.untouched.length, 0)}>
                  <p className={s.muted}>These are paths inside containers, labels or commands, not folders on this server.</p>
                  {plan.files
                    .filter((f) => f.untouched.length)
                    .map((f) => (
                      <div key={f.path}>
                        <p className="mono">{f.path}</p>
                        <pre className={s.code}>{f.untouched.map((u) => `${u.line}: ${u.text}`).join("\n")}</pre>
                      </div>
                    ))}
                </Disclosure>
              )}
            </section>

            <section className={s.planSection}>
              <h3 className={s.planTitle}>
                Startup list <span className={`${s.muted} mono`}>/etc/fstab</span>
              </h3>
              {plan.fstab.action === "none" ? (
                <p className={s.muted}>No change.</p>
              ) : plan.fstab.action === "add" ? (
                <>
                  <p className={s.muted}>Added, so the drive also comes back after a restart:</p>
                  <pre className={s.code}>{plan.fstab.after}</pre>
                </>
              ) : (
                <LineDiff changes={[{ line: plan.fstab.line ?? 0, before: plan.fstab.before ?? "", after: plan.fstab.after ?? "" }]} />
              )}
            </section>

            {plan.gluonRefs.folderGrants + plan.gluonRefs.pins + plan.gluonRefs.trash > 0 && (
              <p className={s.muted}>
                Gluon also moves its own references: {[plan.gluonRefs.folderGrants && fmt.plural(plan.gluonRefs.folderGrants, "shared folder"), plan.gluonRefs.pins && fmt.plural(plan.gluonRefs.pins, "pinned folder"), plan.gluonRefs.trash && fmt.plural(plan.gluonRefs.trash, "item in the trash", "items in the trash")].filter(Boolean).join(", ")}.
              </p>
            )}

            <Disclosure summary="Every step" meta={plan.steps.length}>
              <ol className={s.planSteps}>
                {plan.steps.map((st, i) => (
                  <li key={i}>{st}</li>
                ))}
              </ol>
            </Disclosure>
          </div>
        )}
        {phase === "review" && !plan && <Skeleton height={200} />}

        {phase === "run" && (
          <div className={s.stack}>
            {run.steps.length === 0 && !run.result ? <Skeleton height={16} width="50%" /> : <JobSteps steps={run.steps} />}
            <JobOutcome run={run} />
            {run.result && !run.result.ok && run.result.status === undefined && (
              <Button onClick={() => void makePlan()} loading={planning}>
                Review the plan again
              </Button>
            )}
          </div>
        )}
        </div>
      </Dialog>
      {confirmNode}
    </>
  );
}
