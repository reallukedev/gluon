"use client";
import * as React from "react";
import { api, ApiError } from "@/lib/client/api";
import type { ConflictPolicy, UploadSession } from "@/lib/files-types";

/**
 * Client side of resumable uploads. A module-level store (so uploads keep going while you move
 * between folders or pages) with two uploads in flight at a time, chunked PUTs with progress, pause,
 * cancel, automatic retry when the connection drops, and resuming sessions left by a reload once the
 * person picks the same files again.
 */

export type UploadStatus = "queued" | "starting" | "uploading" | "paused" | "waiting" | "completing" | "done" | "skipped" | "failed" | "cancelled" | "interrupted";

export interface UploadItem {
  key: string;
  id: string | null;
  name: string;
  dir: string;
  size: number;
  received: number;
  file: File | null;
  conflict: ConflictPolicy;
  status: UploadStatus;
  error: string | null;
  /** Smoothed bytes per second. */
  speed: number;
  finalPath: string | null;
  createdAt: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
const finished = new Set<(item: UploadItem) => void>();
let items: UploadItem[] = [];
const xhrs = new Map<string, XMLHttpRequest>();
const MAX_ACTIVE = 2;
const DEFAULT_CHUNK = 8 * 1024 * 1024;

function emit() {
  items = [...items];
  listeners.forEach((l) => l());
}
function patch(key: string, p: Partial<UploadItem>) {
  const i = items.findIndex((x) => x.key === key);
  if (i < 0) return;
  items[i] = { ...items[i]!, ...p };
  emit();
}
const get = (key: string) => items.find((x) => x.key === key);
const active = () => items.filter((x) => x.status === "starting" || x.status === "uploading" || x.status === "completing" || x.status === "waiting").length;

export const uploads = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  snapshot: () => items,
  onFinished(cb: (item: UploadItem) => void) {
    finished.add(cb);
    return () => {
      finished.delete(cb);
    };
  },

  enqueue(list: { file: File; dir: string; name?: string; conflict: ConflictPolicy }[]) {
    const t = Date.now();
    for (const f of list) {
      items.push({
        key: `${t}-${Math.random().toString(36).slice(2)}`,
        id: null,
        name: f.name ?? f.file.name,
        dir: f.dir,
        size: f.file.size,
        received: 0,
        file: f.file,
        conflict: f.conflict,
        status: "queued",
        error: null,
        speed: 0,
        finalPath: null,
        createdAt: t,
      });
    }
    emit();
    pump();
  },

  pause(key: string) {
    const it = get(key);
    if (!it || !["queued", "uploading", "waiting", "starting"].includes(it.status)) return;
    patch(key, { status: "paused", speed: 0 });
    xhrs.get(key)?.abort();
  },
  resume(key: string) {
    const it = get(key);
    if (!it || (it.status !== "paused" && it.status !== "failed")) return;
    patch(key, { status: "queued", error: null });
    pump();
  },
  async cancel(key: string) {
    const it = get(key);
    if (!it) return;
    patch(key, { status: "cancelled", speed: 0 });
    xhrs.get(key)?.abort();
    if (it.id) await api.del(`/api/files/uploads/${it.id}`).catch(() => {});
  },
  clearFinished() {
    items = items.filter((x) => !["done", "skipped", "cancelled"].includes(x.status));
    emit();
  },
  dismiss(key: string) {
    items = items.filter((x) => x.key !== key);
    emit();
  },

  /** Sessions the server still holds from before a reload (their File objects are gone). */
  async loadInterrupted() {
    try {
      const list = await api.get<UploadSession[]>("/api/files/uploads");
      let changed = false;
      for (const s of list) {
        if (s.status !== "open" || items.some((x) => x.id === s.id)) continue;
        items.push({ key: `srv-${s.id}`, id: s.id, name: s.name, dir: s.dir, size: s.size, received: s.received, file: null, conflict: s.conflict, status: "interrupted", error: s.error, speed: 0, finalPath: null, createdAt: s.createdAt });
        changed = true;
      }
      if (changed) emit();
    } catch {
      /* offline: try later */
    }
  },
  /** Match re-picked files (same name and size) to interrupted sessions and continue them. */
  attach(files: File[]): number {
    let n = 0;
    for (const it of items) {
      if (it.status !== "interrupted") continue;
      const f = files.find((x) => x.name === it.name && x.size === it.size);
      if (!f) continue;
      it.file = f;
      it.status = "queued";
      n++;
    }
    emit();
    pump();
    return n;
  },
};

const NO_UPLOADS: ReturnType<typeof uploads.snapshot> = [];
export function useUploads() {
  return React.useSyncExternalStore(uploads.subscribe, uploads.snapshot, () => NO_UPLOADS);
}

// ---------------------------------------------------------------- engine

function pump() {
  while (active() < MAX_ACTIVE) {
    const next = items.find((x) => x.status === "queued" && x.file);
    if (!next) return;
    patch(next.key, { status: "starting" });
    void run(next.key);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise((r) => window.addEventListener("online", () => r(), { once: true }));
}

function stopped(key: string) {
  const s = get(key)?.status;
  return s === "paused" || s === "cancelled" || s === undefined;
}

function putChunk(key: string, id: string, file: File, offset: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.set(key, xhr);
    const started = performance.now();
    let lastT = started;
    let lastB = 0;
    xhr.open("PUT", `/api/files/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      const it = get(key);
      if (!it) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt > 0.25) {
        const inst = (e.loaded - lastB) / dt;
        lastT = now;
        lastB = e.loaded;
        patch(key, { received: offset + e.loaded, speed: it.speed ? it.speed * 0.7 + inst * 0.3 : inst });
      }
    };
    xhr.onload = () => {
      xhrs.delete(key);
      let body: { received?: number; error?: { code: string; message: string; details?: Record<string, unknown> } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* empty */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body.received ?? end);
      reject(new ApiError(body.error?.code ?? "http", body.error?.message ?? `The server answered ${xhr.status}.`, xhr.status, body.error?.details));
    };
    xhr.onerror = () => {
      xhrs.delete(key);
      reject(new ApiError("network", "The connection dropped.", 0));
    };
    xhr.onabort = () => {
      xhrs.delete(key);
      reject(new ApiError("aborted", "Stopped.", 0));
    };
    xhr.send(file.slice(offset, end));
  });
}

async function run(key: string) {
  let it = get(key);
  if (!it?.file) return;
  const file = it.file;
  let attempt = 0;
  try {
    if (!it.id) {
      const s = await api.post<UploadSession & { exists: boolean }>("/api/files/uploads", { dir: it.dir, name: it.name, size: it.size, lastModified: file.lastModified, conflict: it.conflict });
      patch(key, { id: s.id, received: 0 });
    } else {
      const s = await api.get<UploadSession>(`/api/files/uploads/${it.id}`);
      if (s.status !== "open") throw new ApiError("closed", s.error ?? "That upload can't be resumed. Start it again.", 409);
      patch(key, { received: s.received });
    }
    if (stopped(key)) return;
    patch(key, { status: "uploading" });
    for (;;) {
      it = get(key)!;
      if (stopped(key)) return;
      if (it.received >= it.size) break;
      const end = Math.min(it.size, it.received + DEFAULT_CHUNK);
      try {
        const received = await putChunk(key, it.id!, file, it.received, end);
        attempt = 0;
        patch(key, { received, status: "uploading" });
      } catch (e) {
        if (stopped(key)) return;
        const err = e as ApiError;
        if (err.code === "offset" && typeof err.details?.received === "number") {
          patch(key, { received: err.details.received as number });
          continue;
        }
        if (err.status === 0 || err.status >= 500 || err.code === "interrupted" || err.code === "busy") {
          // Connection trouble: wait (and for the network to come back), then ask where to resume.
          attempt++;
          patch(key, { status: "waiting", speed: 0, error: navigator.onLine ? "Connection lost. Retrying…" : "You're offline. Waiting for the connection…" });
          await waitOnline();
          await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
          if (stopped(key)) return;
          try {
            const s = await api.get<UploadSession>(`/api/files/uploads/${it.id}`);
            patch(key, { received: s.received, status: "uploading", error: null });
          } catch {
            /* still offline: loop and wait again */
          }
          continue;
        }
        throw err;
      }
    }
    patch(key, { status: "completing", speed: 0 });
    let s = await api.post<UploadSession>(`/api/files/uploads/${get(key)!.id}/complete`);
    while (s.status === "completing") {
      await sleep(2000);
      s = await api.get<UploadSession>(`/api/files/uploads/${s.id}`);
    }
    if (s.status === "open" && s.error) throw new ApiError("failed", s.error, 500);
    patch(key, { status: s.status === "skipped" ? "skipped" : "done", finalPath: s.finalPath, file: null, error: null, received: s.size });
    const done = get(key);
    if (done) finished.forEach((f) => f(done));
  } catch (e) {
    if (!stopped(key)) patch(key, { status: "failed", speed: 0, error: e instanceof Error ? e.message : "The upload failed." });
  } finally {
    pump();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (items.some((x) => ["queued", "starting", "uploading", "waiting", "completing"].includes(x.status))) {
      e.preventDefault();
    }
  });
}
