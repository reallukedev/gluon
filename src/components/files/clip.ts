"use client";
import * as React from "react";

/**
 * The Files clipboard: ⌘C / ⌘X in one folder, ⌘V in another. It lives for the tab (moving between
 * folders keeps it) and never touches the system clipboard, which can't hold server paths anyway.
 */
export interface Clip {
  mode: "copy" | "cut";
  paths: string[];
  /** Name of the first item, for "Paste Photos" / "Paste 3 items". */
  first: string;
  /** Folder they came from. */
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
