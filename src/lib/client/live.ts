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

function open() {
  if (es || typeof window === "undefined" || document.hidden) return;
  emit({ status: "connecting" });
  es = new EventSource("/api/metrics/live");
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { host: HostSample[]; containers: LiveState["containers"] };
    retry = 0;
    emit({ host: d.host, containers: d.containers, status: "live" });
  });
  es.addEventListener("host", (e) => {
    const h = JSON.parse((e as MessageEvent).data) as HostSample;
    emit({ host: [...state.host.slice(-(HOST_KEEP - 1)), h], status: "live" });
  });
  es.addEventListener("containers", (e) => {
    const c = JSON.parse((e as MessageEvent).data) as LiveState["containers"][number];
    emit({ containers: [...state.containers.slice(-(CTR_KEEP - 1)), c] });
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

const getSnapshot = () => state;
const serverSnapshot: LiveState = { host: [], containers: [], status: "connecting" };

export function useLive(): LiveState {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

/** Latest container sample by name. */
export function useContainerStats(): Map<string, ContainerSample> {
  const { containers } = useLive();
  const last = containers.at(-1);
  return React.useMemo(() => new Map((last?.list ?? []).map((c) => [c.name, c])), [last]);
}
