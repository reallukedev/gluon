"use client";
import * as React from "react";
import type { HostSample, ContainerSample } from "@/server/metrics/sampler";

/**
 * One EventSource for live metrics, shared by every component on the page (spectrum, charts,
 * widgets). Opens on first subscriber, closes when the last unmounts or the tab is hidden.
 */

interface LiveState {
  host: HostSample[];
  containers: { t: number; list: ContainerSample[] }[];
  status: "connecting" | "live" | "offline";
}

let state: LiveState = { host: [], containers: [], status: "connecting" };
const listeners = new Set<() => void>();
let es: EventSource | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const HOST_KEEP = 180;
const CTR_KEEP = 120;

function emit(next: Partial<LiveState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

function open() {
  if (es || typeof window === "undefined" || document.hidden) return;
  emit({ status: "connecting" });
  es = new EventSource("/api/metrics/live");
  es.addEventListener("snapshot", (e) => {
    const d = parse<{ host: HostSample[]; containers: LiveState["containers"] }>(e);
    if (!d) return;
    retry = 0;
    emit({ host: d.host, containers: d.containers, status: "live" });
  });
  es.addEventListener("host", (e) => {
    const h = parse<HostSample>(e);
    if (h) emit({ host: [...state.host.slice(-(HOST_KEEP - 1)), h], status: "live" });
  });
  es.addEventListener("containers", (e) => {
    const c = parse<LiveState["containers"][number]>(e);
    if (c) emit({ containers: [...state.containers.slice(-(CTR_KEEP - 1)), c] });
  });
  es.onerror = () => {
    close();
    emit({ status: "offline" });
    if (!listeners.size) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(open, 500 * 2 ** retry);
  };
}

function close() {
  es?.close();
  es = null;
  clearTimeout(retryTimer);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
    else if (listeners.size) {
      retry = 0;
      open();
    }
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) open();
  return () => {
    listeners.delete(l);
    if (!listeners.size) close();
  };
}

// Only pages that show live numbers load this module, and they load it before they hydrate: open the
// stream now so the first readings are usually here when the page can show them, instead of a skeleton
// that fills in a beat later. If nothing subscribes soon after, let it go.
if (typeof window !== "undefined") {
  open();
  setTimeout(() => {
    if (!listeners.size) close();
  }, 5_000);
}

const getSnapshot = () => state;
const serverSnapshot: LiveState = { host: [], containers: [], status: "connecting" };

export function useLive(): LiveState {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

/** Latest container sample by name. */
export function useContainerStats(): Map<string, ContainerSample> {
  const { containers, status } = useLive();
  // A frozen sample from before the stream dropped isn't a reading.
  const last = status === "live" ? containers.at(-1) : undefined;
  return React.useMemo(() => new Map((last?.list ?? []).map((c) => [c.name, c])), [last]);
}
