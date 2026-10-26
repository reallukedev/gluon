"use client";
import * as React from "react";
import { mutate } from "swr";
import { api, ApiError, streamPost } from "@/lib/client/api";
import type { CheckupEvent, CheckupKind, CheckupRun } from "@/lib/diagnostics-types";

/** A run as the page shows it: stored runs and live ones share this shape. */
export interface RunView extends CheckupRun {
  /** Ids probing right now (live runs only). */
  running: string[];
  live: boolean;
}

export const toView = (r: CheckupRun): RunView => ({ ...r, running: [], live: false });

export const STATE_URL = "/api/diagnostics/checkup";

function reduce(v: RunView | null, e: CheckupEvent): RunView | null {
  switch (e.type) {
    case "start":
      return { meta: e.meta, plan: e.plan, results: e.results, summary: null, running: e.running, live: true };
    case "begin":
      return v ? { ...v, running: v.running.includes(e.id) ? v.running : [...v.running, e.id] } : v;
    case "result":
      if (!v) return v;
      return { ...v, running: v.running.filter((x) => x !== e.result.id), results: [...v.results.filter((r) => r.id !== e.result.id), e.result] };
    case "done":
      return v ? { ...v, summary: e.summary, running: [], live: false } : v;
    default:
      return v;
  }
}

/*
 * The live run lives outside React so it survives switching Diagnostics tabs or visiting another page:
 * the stream stays open while Gluon is open in this browser tab. Closing or reloading the tab closes it,
 * and the server stops the run once nobody is watching.
 */
interface Snapshot {
  view: RunView | null;
  pending: { kind: CheckupKind; target: string | null } | null;
  error: string | null;
}

let snap: Snapshot = { view: null, pending: null, error: null };
let ctrl: AbortController | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<Snapshot> | ((s: Snapshot) => Partial<Snapshot>)) => {
  snap = { ...snap, ...(typeof patch === "function" ? patch(snap) : patch) };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const SERVER_SNAP: Snapshot = { view: null, pending: null, error: null };

export async function startCheckup(kind: CheckupKind, target: string | null = null) {
  ctrl?.abort();
  const c = new AbortController();
  ctrl = c;
  set({ error: null, pending: { kind, target } });
  // Results arrive in bursts; fold each burst into one render.
  let queue: CheckupEvent[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = queue;
    queue = [];
    set((s) => ({ view: batch.reduce(reduce, s.view) }));
  };
  try {
    await streamPost<CheckupEvent>(
      STATE_URL,
      { kind, target },
      (e) => {
        if (c.signal.aborted) return;
        if (e.type === "error") return set({ error: e.message });
        if (e.type === "start") set({ pending: null, view: null });
        queue.push(e);
        if (e.type === "start" || e.type === "done") flush();
        else if (!frame) frame = requestAnimationFrame(flush);
      },
      c.signal,
    );
    if (frame) cancelAnimationFrame(frame);
    if (queue.length) flush();
  } catch (e) {
    const quiet = c.signal.aborted || (e as Error).name === "AbortError" || (e instanceof ApiError && e.code === "reauth_cancelled");
    if (!quiet) set({ error: e instanceof Error ? e.message : "The checkup couldn't start." });
  } finally {
    if (ctrl === c) {
      ctrl = null;
      set({ pending: null });
    }
    void mutate(STATE_URL);
  }
}

/** Stop the run for everyone watching; the stream then ends with a "stopped" summary. */
export async function stopCheckup() {
  const id = snap.view?.live ? snap.view.meta.id : null;
  if (!id) {
    ctrl?.abort();
    set({ pending: null });
    return;
  }
  try {
    await api.del(`${STATE_URL}/${encodeURIComponent(id)}`);
  } catch {
    ctrl?.abort();
  }
}

export function dismissError() {
  set({ error: null });
}

export function useCheckupRun() {
  const s = React.useSyncExternalStore(subscribe, () => snap, () => SERVER_SNAP);
  const streaming = !!s.pending || !!(s.view?.live && !s.view.summary);
  return { ...s, streaming };
}
