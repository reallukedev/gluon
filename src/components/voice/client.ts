"use client";
import * as React from "react";
import { api, ApiError, streamPost } from "@/lib/client/api";
import { toast } from "@/components/ui/Toast";
import { emptyJob, reduceJob, type JobView } from "@/components/builder/state";
import type { JobEvent } from "@/lib/builder-types";
import type { VoiceOp } from "@/server/voice/service";

export const voiceUrl = (appId: string, rest = "") => `/api/voice/${encodeURIComponent(appId)}${rest}`;

/** The person closed the "confirm it's you" prompt: not an error worth a toast. */
export const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";

export async function act(appId: string, op: VoiceOp, opts: { inline?: boolean } = {}): Promise<boolean> {
  try {
    const r = await api.post<{ message: string }>(voiceUrl(appId, "/act"), op);
    toast.success(r.message);
    return true;
  } catch (e) {
    if (quiet(e)) return false;
    if (opts.inline) throw e;
    toast.error("That didn't work", { description: e instanceof Error ? e.message : undefined });
    return false;
  }
}

/** The job belongs to the server: leaving stops reading, not the work. */
export function useVoiceJob(onFinished: () => void) {
  const [view, setView] = React.useState<JobView | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const done = React.useRef(onFinished);
  done.current = onFinished;
  React.useEffect(() => () => abort.current?.abort(), []);

  const start = React.useCallback(async (url: string) => {
    if (abort.current && !abort.current.signal.aborted && running) return;
    setError(null);
    setRunning(true);
    setView({ ...emptyJob });
    abort.current = new AbortController();
    let ended = false;
    try {
      await streamPost<JobEvent>(
        url,
        {},
        (e) => {
          if (e.type === "done") ended = true;
          setView((v) => reduceJob(v ?? emptyJob, e));
        },
        abort.current.signal,
      );
      if (!ended) setView((v) => reduceJob(v ?? emptyJob, { type: "error", message: "Gluon lost track of it before it finished. It may still be running; this page catches up in a moment." }));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setView(null);
      setError(quiet(e) ? null : e instanceof Error ? e.message : "That didn't start.");
    } finally {
      setRunning(false);
      done.current();
    }
  }, [running]);

  const reset = React.useCallback(() => {
    setView(null);
    setError(null);
  }, []);

  return { view, running, error, start, reset };
}

export const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`;

export const initial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();

export function shortDuration(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.floor(secs))} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days`;
}
