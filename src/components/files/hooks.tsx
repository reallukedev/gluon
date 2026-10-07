"use client";
import * as React from "react";
import type { FileEntry, FileKind, FolderSize, Listing as ListingT, Places, SearchHit } from "@/lib/files-types";
import { api } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { baseName, isDirLike } from "./lib";
import type { FolderView } from "./logic";

// Data hooks and small helpers the Files screens share.

// ---------------------------------------------------------------- search

export interface SearchSpec {
  roots: string[];
  q: string;
  kinds?: FileKind[];
  type?: "file" | "dir" | "any";
  modifiedWithinDays?: number;
  minSize?: number;
  limit?: number;
  depth?: number;
  /** The name may also match a folder on the way to a file. */
  inPath?: boolean;
}

export interface SearchState {
  hits: SearchHit[];
  done: boolean;
  truncated: boolean;
  timedOut: boolean;
  error: string | null;
}

const EMPTY_SEARCH: SearchState = { hits: [], done: false, truncated: false, timedOut: false, error: null };

/** Name search streamed from every root at once, merged as hits arrive. null spec = idle. */
/** Finished collections, kept for this visit so going back to the front page doesn't scan again. */
const searchCache = new Map<string, { at: number; state: SearchState }>();
const CACHE_MS = 5 * 60_000;
/** Forget cached results (after anything changed files). */
export function clearSearchCache() {
  searchCache.clear();
}

export function useFileSearch(spec: SearchSpec | null, opts: { cache?: boolean } = {}): SearchState & { retry: () => void } {
  const [nonce, setNonce] = React.useState(0);
  const key = spec ? `${JSON.stringify(spec)}#${nonce}` : null;
  const cacheKey = spec ? JSON.stringify(spec) : null;
  const [st, setSt] = React.useState<SearchState & { key: string | null }>({ ...EMPTY_SEARCH, key: null });
  const useCache = !!opts.cache;
  React.useEffect(() => {
    if (!key || !cacheKey) return;
    const s = JSON.parse(cacheKey) as SearchSpec;
    // Nowhere to look (a member with pins but no shares): done, with nothing found.
    if (!s.roots.length) return setSt({ ...EMPTY_SEARCH, done: true, key });
    const hit = useCache ? searchCache.get(cacheKey) : undefined;
    if (hit && Date.now() - hit.at < CACHE_MS) return setSt({ ...hit.state, key });
    setSt({ ...EMPTY_SEARCH, key });
    // One stream for every root, so a search never holds more than one of the browser's connections.
    const q = new URLSearchParams({ q: s.q || "*", limit: String(s.limit ?? 600) });
    if (s.roots.length === 1) q.set("path", s.roots[0]!);
    else q.set("roots", JSON.stringify(s.roots.slice(0, 20)));
    if (s.kinds?.length) q.set("kinds", s.kinds.join(","));
    if (s.type) q.set("type", s.type);
    if (s.modifiedWithinDays) q.set("modifiedWithinDays", String(s.modifiedWithinDays));
    if (s.minSize) q.set("minSize", String(s.minSize));
    if (s.depth) q.set("depth", String(s.depth));
    if (s.inPath) q.set("inPath", "1");
    const es = new EventSource(`/api/files/search?${q}`);
    const finish = (patch: Partial<SearchState>) => {
      es.close();
      setSt((cur) => {
        if (cur.key !== key) return cur;
        const next = { ...cur, ...patch, done: true };
        if (useCache && !next.error) searchCache.set(cacheKey, { at: Date.now(), state: { hits: next.hits, done: true, truncated: next.truncated, timedOut: next.timedOut, error: null } });
        return next;
      });
    };
    es.addEventListener("hits", (e) => {
      const { items } = JSON.parse((e as MessageEvent).data) as { items: SearchHit[] };
      if (items.length) setSt((cur) => (cur.key !== key ? cur : { ...cur, hits: [...cur.hits, ...items] }));
    });
    es.addEventListener("done", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { truncated: boolean; timedOut: boolean };
      finish({ truncated: d.truncated, timedOut: d.timedOut });
    });
    es.addEventListener("error", (e) => {
      let message = "The search stopped. Try again.";
      try {
        const data = (e as MessageEvent).data;
        if (data) message = (JSON.parse(data) as { message: string }).message;
      } catch {
        /* default */
      }
      finish({ error: message });
    });
    return () => es.close();
  }, [key, cacheKey, useCache]);
  const retry = React.useCallback(() => {
    if (cacheKey) searchCache.delete(cacheKey);
    setNonce((n) => n + 1);
  }, [cacheKey]);
  // No spec at all counts as nothing to find, so nothing waits on it forever.
  if (!spec) return { ...EMPTY_SEARCH, retry };
  return st.key === key ? { ...st, retry } : { ...EMPTY_SEARCH, retry };
}

/** Search hits carry what a thumbnail needs; previews need a stat for the rest. */
export async function statEntry(path: string): Promise<FileEntry> {
  return api.get<FileEntry>(`/api/files/stat?path=${encodeURIComponent(path)}`);
}

// ---------------------------------------------------------------- what's in a name

const IMAGE_PREVIEW = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const VIDEO_PLAYABLE = /\.(mp4|m4v|webm|mov|ogv)$/i;
export const isPhoto = (name: string) => IMAGE_PREVIEW.test(name);
export const isPlayable = (name: string) => VIDEO_PLAYABLE.test(name);

/** A file's share of the biggest thing next to it, for the size rule (0 when unknown). */
export function sizeOf(e: Pick<FileEntry, "size" | "dirSize" | "type">): number | null {
  if (e.type === "dir") return e.dirSize?.bytes ?? null;
  return e.size;
}

/** Size of a selection in words: "2.1 GB", "at least 2.1 GB", or null when no size is known. */
export function useSelectionSize(entries: FileEntry[]): string | null {
  const fmt = useFormat();
  let bytes = 0;
  let unknown = 0;
  for (const e of entries) {
    if (isDirLike(e)) {
      if (e.dirSize) bytes += e.dirSize.bytes;
      else unknown++;
    } else bytes += e.size ?? 0;
  }
  if (!entries.length || unknown === entries.length) return null;
  return `${unknown ? "at least " : ""}${fmt.bytes(bytes)}`;
}

/** Places to offer as destinations and shortcuts, in a stable order without duplicates. */
export function placeList(places: Places | undefined) {
  if (!places) return [];
  const seen = new Set<string>();
  return [...places.pins, ...places.places, ...places.recent].filter((p) => !p.missing && !seen.has(p.path) && !!seen.add(p.path));
}

/** Roots to search across for collections: everything a person keeps files in, not the OS. */
export function collectionRoots(places: Places | undefined): string[] {
  if (!places) return [];
  const list = places.places.filter((p) => !p.missing && p.kind !== "root" && (p.kind !== "drive" || p.fs)).map((p) => p.path);
  // Searching a folder already covers what's inside it.
  return list.filter((p) => !list.some((q) => q !== p && (p.startsWith(`${q}/`) || q === "/")));
}

// ---------------------------------------------------------------- the one sentence of state

/** "340 photos and 2 folders, 24 MB in all. 1.2 TB free on the 1.8 TB hard drive." */
export function folderSentence(l: ListingT, places: Places | undefined, fmt: ReturnType<typeof useFormat>, admin: boolean): string {
  const c = l.counts;
  const files = c.files + c.links + c.other;
  const parts = [c.dirs ? fmt.plural(c.dirs, "folder") : null, files ? fmt.plural(files, "file") : null].filter(Boolean);
  let out = parts.length ? parts.join(" and ") : c.hidden ? `Only ${fmt.plural(c.hidden, "hidden item")}` : "Empty";
  if (l.self.dirSize && parts.length) out += `, ${fmt.bytes(l.self.dirSize.bytes)} in all`;
  out += ".";
  if (l.fs) {
    const drive = places?.places.find((p) => (p.kind === "drive" || p.kind === "root") && p.path === l.fs!.mount);
    const on = !admin ? "" : drive && drive.path !== l.path && drive.kind === "drive" ? ` on ${drive.label}` : l.fs.mount === "/" ? " on the system drive" : ` on ${l.fs.mount}`;
    out += ` ${fmt.bytes(l.fs.avail)} free${on}.`;
  }
  if (l.access === "read") out += " You can look and download here, not change things.";
  return out;
}

/** A drive, home or share by its human name when the folder is one, else the folder's own name. */
export function folderTitle(l: ListingT | undefined, path: string, places: Places | undefined): string {
  const here = l ? places?.places.find((p) => p.path === l.path) : undefined;
  if (here) return here.label;
  if (l) return l.path === "/" ? "Computer" : l.name;
  return baseName(path) === "/" ? "Computer" : baseName(path);
}

// ---------------------------------------------------------------- folder sizes, measured without asking

const SIZE_STALE_MS = 60 * 60_000;
/** Don't re-measure a folder that was measured this recently, however much changes. */
const SIZE_REST_MS = 30_000;
/** A measured size is out of date when the folder itself changed after it (something added or removed). */
const staleSize = (e: FileEntry) => !!e.dirSize && e.mtime > e.dirSize.computedAt + 1000;

/**
 * When a folder opens with sub-folders whose size isn't known (or its own measurement is over an
 * hour old), the server measures it once (du, one level deep, at most two at a time) and the
 * listing refreshes when it's done. Returns whether a measurement is running.
 */
export function useFolderSizes(listing: ListingT | undefined, onDone: () => void) {
  const [measuring, setMeasuring] = React.useState(false);
  const done = React.useRef(onDone);
  done.current = onDone;
  const path = listing?.path ?? null;
  const self = listing?.self;
  const changed = !!listing && (!self?.dirSize || staleSize(self) || listing.entries.some((e) => e.type === "dir" && (!e.dirSize || staleSize(e))));
  const needs = !!listing && listing.counts.dirs > 0 && (changed || Date.now() - (self?.dirSize?.computedAt ?? 0) > SIZE_STALE_MS);
  const before = self?.dirSize?.computedAt ?? 0;
  React.useEffect(() => {
    setMeasuring(false);
    if (!path || !needs) return;
    let live = true;
    const url = `/api/files/size?path=${encodeURIComponent(path)}`;
    const again = changed && Date.now() - before > SIZE_REST_MS;
    void (async () => {
      let r = await api.get<FolderSize>(again ? `${url}&refresh=1` : url);
      if (!live) return;
      if (!r.running) {
        if ((r.computedAt ?? 0) > before) done.current();
        return;
      }
      setMeasuring(true);
      // Poll gently: often seconds, sometimes minutes on a big media drive (du stops at 20 min).
      for (let i = 0; live && r.running && i < 400; i++) {
        await new Promise((ok) => setTimeout(ok, Math.min(1200 + i * 400, 5000)));
        if (!live) return;
        r = await api.get<FolderSize>(url);
      }
      if (!live) return;
      setMeasuring(false);
      done.current();
    })().catch(() => live && setMeasuring(false));
    return () => {
      live = false;
    };
    // Once per folder visit; the refresh that follows must not start another round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, needs]);
  return measuring;
}

/** Remembered per-folder views, kept in this browser. */
const VIEW_KEY = "gluon.files.views";
export function readViews(): Record<string, FolderView> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, FolderView>;
  } catch {
    return {};
  }
}
export function writeViews(v: Record<string, FolderView>) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

/** True when the item is a file kind the lightbox shows (photos and playable video). */
export const inLightbox = (e: Pick<FileEntry, "preview">) => e.preview === "image" || e.preview === "video";
