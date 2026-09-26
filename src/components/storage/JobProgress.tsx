"use client";
import * as React from "react";
import { useStream } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import type { JobStep, StorageJob } from "@/lib/storage-types";
import s from "./storage.module.css";

/** Events from the storage job stream (NDJSON on POST, SSE on reattach — same payloads). */
export type JobEvent =
  | { type: "job"; job: StorageJob }
  | { type: "step"; id: string; text: string; state: JobStep["status"]; undo: boolean; detail: string | null; error: string | null }
  | { type: "progress"; done: number; total: number }
  | { type: "done"; ok: boolean; status: StorageJob["status"]; message: string; job?: StorageJob }
  | { type: "error"; message: string };

export interface JobRun {
  job: StorageJob | null;
  steps: JobStep[];
  result: { ok: boolean; message: string; status?: StorageJob["status"] } | null;
}

export const emptyRun: JobRun = { job: null, steps: [], result: null };

export function reduceJob(st: JobRun, e: JobEvent): JobRun {
  switch (e.type) {
    case "job":
      return { ...st, job: e.job, steps: e.job.steps };
    case "step": {
      const i = st.steps.findIndex((x) => x.id === e.id);
      const prev = i >= 0 ? st.steps[i]! : null;
      const next: JobStep = { id: e.id, label: e.text, status: e.state, undo: e.undo, detail: e.detail, error: e.error, startedAt: prev?.startedAt ?? Date.now(), finishedAt: null };
      const steps = i >= 0 ? st.steps.map((x, j) => (j === i ? next : x)) : [...st.steps, next];
      return { ...st, steps };
    }
    case "progress":
      return st;
    case "done":
      return { job: e.job ?? st.job, steps: e.job?.steps ?? st.steps, result: { ok: e.ok, message: e.message, status: e.status } };
    case "error":
      return { ...st, result: { ok: false, message: e.message } };
  }
}

const STEP_WORD: Partial<Record<JobStep["status"], string>> = { skipped: "didn't run", undone: "put back", "undo-failed": "couldn't put back", failed: "failed" };

/** A checklist of the operation's steps, drawn with the state-line vocabulary. */
export function JobSteps({ steps }: { steps: JobStep[] }) {
  const firstUndo = steps.findIndex((x) => x.undo);
  return (
    <ol className={s.steps}>
      {steps.map((st, i) => (
        <React.Fragment key={st.id}>
          {i === firstUndo && <li className={s.stepsHeading}>Putting things back</li>}
          <li data-state={st.status} data-undo={st.undo ? "" : undefined}>
            <span className={s.stepMark} aria-hidden />
            <span className={s.stepText}>
              <span>
                {st.label}
                {STEP_WORD[st.status] && <span className={s.stepWord}> · {STEP_WORD[st.status]}</span>}
              </span>
              {st.detail && <span className={s.stepDetail}>{st.detail}</span>}
              {st.error && <span className={s.stepError}>{st.error}</span>}
            </span>
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

export function JobOutcome({ run }: { run: JobRun }) {
  if (!run.result) return null;
  if (run.result.ok) return <Notice title="Done">{run.result.message}</Notice>;
  const rolledBack = run.result.status === "rolled-back";
  return (
    <Notice tone={rolledBack ? "neutral" : "fault"} title={rolledBack ? "Stopped, and everything was put back" : "This didn't finish"}>
      {run.result.message}
    </Notice>
  );
}

/** Follow a running (or finished) job over SSE; used after a reload (`?job=`). */
export function useJobFollow(id: string | null) {
  const [run, setRun] = React.useState<JobRun>(emptyRun);
  const [finished, setFinished] = React.useState(false);
  React.useEffect(() => {
    setRun(emptyRun);
    setFinished(false);
  }, [id]);
  const apply = (e: JobEvent) => {
    setRun((st) => reduceJob(st, e));
    if (e.type === "done" || e.type === "error") setFinished(true);
  };
  useStream(id && !finished ? `/api/storage/operations/${encodeURIComponent(id)}/stream` : null, {
    job: (d) => apply({ type: "job", job: d as StorageJob }),
    step: (d) => apply({ ...(d as object), type: "step" } as JobEvent),
    done: (d) => apply({ ...(d as object), type: "done" } as JobEvent),
    error: (d) => apply({ type: "error", message: (d as { message?: string }).message ?? "That operation can't be shown." }),
  });
  return run;
}

/** Shows an operation by id (reattaching to it if it's still running). */
export function JobDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const run = useJobFollow(id);
  const running = !!run.job && !run.result && run.job.status === "running";
  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={run.job?.title ?? "Storage change"}
      description={
        run.job ? (
          <>
            {run.job.username ? `${run.job.username} started this ` : "Started "}
            <Time ts={run.job.startedAt} />.{running ? " It keeps going if you close this." : ""}
          </>
        ) : undefined
      }
      size="wide"
      footer={
        <Button variant={running ? "ghost" : "primary"} onClick={onClose}>
          {running ? "Hide" : "Close"}
        </Button>
      }
    >
      {!run.job && !run.result ? (
        <div className={s.stack}>
          <Skeleton height={16} width="70%" />
          <Skeleton height={16} width="55%" />
          <Skeleton height={16} width="62%" />
        </div>
      ) : (
        <div className={s.stack}>
          <JobSteps steps={run.steps} />
          <JobOutcome run={run} />
        </div>
      )}
    </Dialog>
  );
}
