"use client";
import * as React from "react";

/** Lives for the tab and never touches the system clipboard, which can't hold server paths anyway. */
export interface Clip {
  mode: "copy" | "cut";
  paths: string[];
  first: string;
  from: string;
}

let current: Clip | null = null;
const listeners = new Set<() => void>();

export const clip = {
  get: () => current,
  set(next: Clip | null) {
    current = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export function useClip(): Clip | null {
  return React.useSyncExternalStore(clip.subscribe, clip.get, () => null);
}
