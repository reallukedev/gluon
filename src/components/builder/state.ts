"use client";
import * as React from "react";
import type { Document } from "yaml";
import { ApiError, api } from "@/lib/client/api";
import { parseCompose, stringify } from "@/lib/builder/compose";
import type { AppSpec, CustomAppDetail, JobEvent, JobKind, SecretNames } from "@/lib/builder-types";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

interface PendingOps {
  set: Record<string, Record<string, string>>;
  remove: Record<string, string[]>;
  renameService?: { from: string; to: string };
  token?: string | null;
  github?: { branch: string; path: string };
}

const emptyOps = (): PendingOps => ({ set: {}, remove: {} });
const hasOps = (o: PendingOps) => Object.keys(o.set).length > 0 || Object.keys(o.remove).length > 0 || !!o.renameService || o.token !== undefined || !!o.github;

/**
 * The draft being edited, saved on its own shortly after each change (and when the page is left).
 * Secret values go up once and never come back: the client only ever knows their names.
 */
export function useDraft(detail: CustomAppDetail, onSaved: (d: Partial<CustomAppDetail>) => void) {
  const [spec, setSpecState] = React.useState<AppSpec>(detail.spec);
  const [secrets, setSecrets] = React.useState<SecretNames>(detail.secrets);
  const [state, setState] = React.useState<SaveState>("saved");
  const [savedAt, setSavedAt] = React.useState<number>(detail.updatedAt);
  const [error, setError] = React.useState<string | null>(null);
  const base = React.useRef(detail.rev);
  const specRef = React.useRef(spec);
  const ops = React.useRef<PendingOps>(emptyOps());
  const dirty = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = React.useRef<Promise<void> | null>(null);
  const onSavedRef = React.useRef(onSaved);
  onSavedRef.current = onSaved;

  // Adopt the server's copy when it moved on (a publish bumps it) and nothing local is waiting.
  React.useEffect(() => {
    if (!dirty.current && !inflight.current && detail.rev !== base.current) {
      base.current = detail.rev;
      specRef.current = detail.spec;
      setSpecState(detail.spec);
      setSecrets(detail.secrets);
    }
  }, [detail.rev, detail.spec, detail.secrets]);

  const save = React.useCallback(async (keepalive = false): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current.catch(() => undefined);
    if (!dirty.current) return;
    const sending = ops.current;
    ops.current = emptyOps();
    dirty.current = false;
    const body = {
      rev: base.current,
      spec: specRef.current,
      ...(Object.keys(sending.set).length || Object.keys(sending.remove).length || sending.renameService ? { secrets: { set: sending.set, remove: sending.remove, renameService: sending.renameService } } : {}),
      ...(sending.token !== undefined ? { token: sending.token } : {}),
      ...(sending.github ? { github: sending.github } : {}),
    };
    if (keepalive) {
      void fetch(`/api/custom-apps/${detail.id}`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
      return;
    }
    setState("saving");
    let outcome = "ok" as "ok" | "retry" | "stop";
    const p = (async () => {
      try {
        const r = await api.put<{ rev: number; updatedAt: number }>(`/api/custom-apps/${detail.id}`, body);
        base.current = r.rev;
        setSavedAt(r.updatedAt);
        setError(null);
        setState(dirty.current ? "dirty" : "saved");
        onSavedRef.current({ rev: r.rev, updatedAt: r.updatedAt, spec: body.spec });
      } catch (e) {
        // Put the unsent operations back so nothing typed is lost.
        const back = ops.current;
        ops.current = { ...sending, set: mergeSet(sending.set, back.set), remove: { ...sending.remove, ...back.remove }, token: back.token ?? sending.token, github: back.github ?? sending.github };
        dirty.current = true;
        if (e instanceof ApiError && e.code === "stale") {
          outcome = "stop";
          setState("conflict");
          setError(e.message);
        } else {
          setState("error");
          setError(e instanceof Error ? e.message : "Couldn't save.");
          // Network trouble retries on its own; a refused value waits for the next edit.
          outcome = e instanceof ApiError && e.status >= 400 && e.status < 500 ? "stop" : "retry";
        }
      }
    })();
    inflight.current = p;
    await p;
    inflight.current = null;
    if (dirty.current && !timer.current && outcome !== "stop") timer.current = setTimeout(() => void save(), outcome === "retry" ? 5000 : 700);
  }, [detail.id]);

  const schedule = React.useCallback(() => {
    dirty.current = true;
    setState((s) => (s === "conflict" ? s : "dirty"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  }, [save]);

  const setSpec = React.useCallback(
    (next: AppSpec | ((s: AppSpec) => AppSpec)) => {
      const v = typeof next === "function" ? next(specRef.current) : next;
      if (v === specRef.current) return;
      specRef.current = v;
      setSpecState(v);
      schedule();
    },
    [schedule],
  );

  /** Edit the compose document in place (the form's writers), keeping everything else. */
  const editCompose = React.useCallback(
    (fn: (doc: Document) => void) => {
      const parsed = parseCompose(specRef.current.compose);
      if (!parsed.ok) return false;
      fn(parsed.doc);
      const text = stringify(parsed.doc);
      setSpec((s) => ({ ...s, compose: text }));
      return true;
    },
    [setSpec],
  );

  const setSecret = React.useCallback(
    (service: string, key: string, value: string) => {
      ops.current.set[service] = { ...(ops.current.set[service] ?? {}), [key]: value };
      const rm = ops.current.remove[service];
      if (rm) ops.current.remove[service] = rm.filter((k) => k !== key);
      setSecrets((s) => ({ ...s, [service]: [...new Set([...(s[service] ?? []), key])] }));
      schedule();
    },
    [schedule],
  );

  const removeSecret = React.useCallback(
    (service: string, key: string) => {
      ops.current.remove[service] = [...new Set([...(ops.current.remove[service] ?? []), key])];
      if (ops.current.set[service]) delete ops.current.set[service]![key];
      setSecrets((s) => ({ ...s, [service]: (s[service] ?? []).filter((k) => k !== key) }));
      schedule();
    },
    [schedule],
  );

  /** Renames go up on their own, so secrets of the old name can't mix with new ones. */
  const renameSecrets = React.useCallback(
    async (from: string, to: string) => {
      await save();
      ops.current.renameService = { from, to };
      setSecrets((s) => {
        const n = { ...s };
        if (n[from]) {
          n[to] = [...new Set([...(n[to] ?? []), ...n[from]!])];
          delete n[from];
        }
        return n;
      });
      dirty.current = true;
    },
    [save],
  );

  const setToken = React.useCallback(
    (token: string | null) => {
      ops.current.token = token;
      schedule();
    },
    [schedule],
  );

  const setGithub = React.useCallback(
    (g: { branch: string; path: string }) => {
      ops.current.github = g;
      schedule();
    },
    [schedule],
  );

  /** Take the server's copy (after a conflict). */
  const reset = React.useCallback((d: CustomAppDetail) => {
    ops.current = emptyOps();
    dirty.current = false;
    base.current = d.rev;
    specRef.current = d.spec;
    setSpecState(d.spec);
    setSecrets(d.secrets);
    setState("saved");
    setError(null);
  }, []);

  // Leaving the page (or hiding it on a phone) sends whatever is waiting.
  React.useEffect(() => {
    const flush = () => {
      if (dirty.current || hasOps(ops.current)) void save(true);
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [save]);

  return { spec, setSpec, editCompose, secrets, setSecret, removeSecret, renameSecrets, setToken, setGithub, state, savedAt, error, save, reset, isDirty: () => dirty.current || !!inflight.current };
}

function mergeSet(a: Record<string, Record<string, string>>, b: Record<string, Record<string, string>>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

export type Draft = ReturnType<typeof useDraft>;

// ---------------------------------------------------------------- jobs

export interface JobView {
  kind: JobKind | null;
  stages: { key: string; label: string }[];
  stage: string | null;
  steps: { text: string; state: "running" | "done" | "failed" }[];
  lines: { text: string; err: boolean }[];
  progress: { done: number; total: number; current?: string } | null;
  result: { ok: boolean; message: string; detail?: string[] } | null;
}

export const emptyJob: JobView = { kind: null, stages: [], stage: null, steps: [], lines: [], progress: null, result: null };

export function reduceJob(v: JobView, e: JobEvent): JobView {
  switch (e.type) {
    case "plan":
      return { ...v, stages: e.stages ?? v.stages, kind: e.kind ?? v.kind };
    case "stage":
      return { ...v, stage: e.stage ?? v.stage, progress: null };
    case "step": {
      const steps = v.steps.map((x) => (x.state === "running" ? { ...x, state: "done" as const } : x));
      return { ...v, steps: [...steps, { text: e.text ?? "", state: "running" }] };
    }
    case "line":
      return { ...v, lines: [...v.lines.slice(-3000), { text: e.text ?? "", err: e.stream === "err" }] };
    case "progress":
      return { ...v, progress: { done: e.done ?? 0, total: e.total ?? 100, current: e.current } };
    case "done":
    case "error": {
      const ok = e.type === "done" ? !!e.ok : false;
      return { ...v, progress: null, steps: v.steps.map((x) => (x.state === "running" ? { ...x, state: ok ? "done" : "failed" } : x)), result: { ok, message: e.message ?? "", detail: e.detail } };
    }
  }
  return v;
}

export const jobFrom = (events: JobEvent[]) => events.reduce(reduceJob, emptyJob);

/** Read an NDJSON stream from GET (re-attaching to a running job). */
export async function streamGet(url: string, onEvent: (e: JobEvent) => void, signal?: AbortSignal) {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as JobEvent);
    }
  }
}

/** The host links to the app's port use: this server's LAN address, else the one in the address bar. */
export const linkHost = (d: Pick<CustomAppDetail, "lanHost">) => d.lanHost ?? (typeof window !== "undefined" ? window.location.hostname : "localhost");
