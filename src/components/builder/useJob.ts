"use client";
import * as React from "react";
import { ApiError, streamPost } from "@/lib/client/api";
import type { CustomAppDetail, JobEvent } from "@/lib/builder-types";
import { emptyJob, jobFrom, reduceJob, type JobView } from "./state";

export type JobMode = { kind: "publish"; rebuild?: boolean } | { kind: "build" } | { kind: "remove"; keepData: boolean; forget: boolean } | { kind: "attach" };

/**
 * Runs a builder job (publish, build, remove) and follows its NDJSON stream. The job belongs to
 * the server: a second start while one runs attaches to it, and after a reload the polled
 * `detail.job` keeps the view current.
 */
export function useJob(detail: CustomAppDetail, opts: { beforeStart: () => Promise<void>; onFinished: () => void }) {
  const [view, setView] = React.useState<JobView | null>(null);
  const [running, setRunning] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const busy = React.useRef(false);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;
  const job = detail.job;
  // Leaving the page stops reading the stream; the job itself carries on on the server.
  React.useEffect(() => () => abort.current?.abort(), []);

  const start = React.useCallback(
    async (mode: JobMode) => {
      if (mode.kind === "attach" || busy.current) return;
      busy.current = true;
      setStartError(null);
      setRunning(true);
      setView({ ...emptyJob });
      abort.current = new AbortController();
      try {
        await optsRef.current.beforeStart();
        const url = mode.kind === "publish" ? "publish" : mode.kind === "build" ? "build" : "remove";
        const body = mode.kind === "publish" ? { rebuild: !!mode.rebuild } : mode.kind === "remove" ? { keepData: mode.keepData, forget: mode.forget } : {};
        let ended = false;
        await streamPost<JobEvent>(
          `/api/custom-apps/${detail.id}/${url}`,
          body,
          (e) => {
            if (e.type === "done") ended = true;
            setView((v) => reduceJob(v ?? emptyJob, e));
          },
          abort.current.signal,
        );
        if (!ended) setView((v) => reduceJob(v ?? emptyJob, { type: "error", message: "Gluon lost track of it before it finished. It may still be running; this page shows how it ends." }));
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setView(null);
        setStartError(e instanceof ApiError && e.code === "reauth_cancelled" ? null : e instanceof Error ? e.message : "That didn't start.");
      } finally {
        busy.current = false;
        setRunning(false);
        optsRef.current.onFinished();
      }
    },
    [detail.id],
  );

  /** Show the server's copy of the job (after a reload, or when someone else started it). */
  const follow = React.useCallback(() => {
    if (job) setView({ ...jobFrom(job.events), stages: job.stages, kind: job.kind });
  }, [job]);

  /** Forget a previous attempt's error (a dialog opening again starts clean). */
  const reset = React.useCallback(() => setStartError(null), []);

  return { view, setView, running, startError, start, follow, reset, serverRunning: !!job && !job.finishedAt };
}
