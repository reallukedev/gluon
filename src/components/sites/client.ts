"use client";
import { ApiError, useApi } from "@/lib/client/api";
import { checkSitePath, isJunk, SITE_LIMITS, type SiteDetail, type SiteImportResult, type SitesList, type SiteTree } from "@/lib/sites-types";
import { formatBytes } from "@/lib/format";

export const useSites = (initial?: SitesList) => useApi<SitesList>("/api/sites", { refresh: 30_000, fallbackData: initial });
export const useSite = (id: string, initial?: SiteDetail) => useApi<SiteDetail>(`/api/sites/${id}`, { refresh: 20_000, fallbackData: initial });
export const useTree = (id: string) => useApi<SiteTree>(`/api/sites/${id}/files`, { refresh: 10_000 });

export const enc = encodeURIComponent;
export const fileUrl = (id: string, path: string, download = false) => `/api/sites/${id}/raw?path=${enc(path)}${download ? "&download=1" : ""}`;

/** A file picked or dropped, with where it goes in the site. */
export interface Picked {
  file: File;
  rel: string;
}

async function rawPost<T>(url: string, body: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/octet-stream" }, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError("network", "Can't reach the server. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(err?.code ?? "http", err?.message ?? `The server answered ${res.status}.`, res.status, err?.details);
  }
  return data as T;
}

export const uploadOne = (id: string, rel: string, file: Blob, replace: boolean) => rawPost<{ path: string; replaced: boolean; tree: SiteTree }>(`/api/sites/${id}/upload?path=${enc(rel)}${replace ? "&replace=1" : ""}`, file);
export const importZip = (id: string, zip: Blob, into: string) => rawPost<SiteImportResult>(`/api/sites/${id}/import${into ? `?into=${enc(into)}` : ""}`, zip);

/** Split what someone picked into what can go on the site and what can't (and why), before sending anything. */
export function sortPicked(items: Picked[]): { ok: Picked[]; skipped: { rel: string; reason: string }[]; junk: number } {
  const ok: Picked[] = [];
  const skipped: { rel: string; reason: string }[] = [];
  let junk = 0;
  for (const it of items) {
    if (isJunk(it.rel)) {
      junk++;
      continue;
    }
    const c = checkSitePath(it.rel);
    if (!c.ok) skipped.push({ rel: it.rel, reason: c.message });
    else if (it.file.size > SITE_LIMITS.fileBytes) skipped.push({ rel: it.rel, reason: `It's ${formatBytes(it.file.size)}; files can be up to ${formatBytes(SITE_LIMITS.fileBytes)}.` });
    else ok.push({ file: it.file, rel: c.path });
  }
  return { ok, skipped, junk };
}

/**
 * Files from an <input type=file> (with or without webkitdirectory). A picked folder arrives with
 * its own name on every path ("my-site/index.html"); that top folder is dropped so its contents
 * become the site's (or the target folder's) contents.
 */
export function fromInput(list: FileList | null, into: string): Picked[] {
  const files = [...(list ?? [])];
  const rels = files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  const strip = topFolder(rels);
  return files.map((file, i) => ({ file, rel: join(into, rels[i]!.slice(strip.length)) }));
}

function topFolder(rels: string[]): string {
  if (!rels.length || !rels.every((r) => r.includes("/"))) return "";
  const top = rels[0]!.split("/")[0]!;
  return rels.every((r) => r.startsWith(`${top}/`)) ? `${top}/` : "";
}

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Files dropped on the page, walking into dropped folders. */
export async function fromDrop(dt: DataTransfer, into: string): Promise<Picked[]> {
  const entries = [...dt.items].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((file) => ({ file, rel: join(into, file.name) }));
  const out: Picked[] = [];
  // One dropped folder is the site itself; several things dropped keep their own names.
  const single = entries.length === 1 && entries[0]!.isDirectory;
  const walkEntry = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: join(into, join(prefix, e.name)) });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      const kids: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        kids.push(...batch);
      }
      for (const k of kids) await walkEntry(k, join(prefix, e.name));
    }
  };
  for (const e of entries) {
    if (single) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const k of batch) await walkEntry(k, "");
      }
    } else await walkEntry(e, "");
  }
  return out;
}

export interface UploadProgress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null;
}

/** Send files one after another; failures are collected rather than stopping the rest. */
export async function uploadAll(id: string, items: Picked[], replace: boolean, onProgress: (p: UploadProgress) => void): Promise<{ done: number; failed: { rel: string; message: string }[]; tree: SiteTree | null }> {
  const bytesTotal = items.reduce((n, i) => n + i.file.size, 0);
  let bytesDone = 0;
  let done = 0;
  let tree: SiteTree | null = null;
  const failed: { rel: string; message: string }[] = [];
  for (const it of items) {
    onProgress({ done, total: items.length, bytesDone, bytesTotal, current: it.rel });
    try {
      tree = (await uploadOne(id, it.rel, it.file, replace)).tree;
      done++;
    } catch (e) {
      failed.push({ rel: it.rel, message: e instanceof Error ? e.message : "It didn't upload." });
      // The site is full: the rest would fail the same way.
      if (e instanceof ApiError && (e.code === "too_many_files" || e.code === "site_too_large")) {
        for (const rest of items.slice(items.indexOf(it) + 1)) failed.push({ rel: rest.rel, message: e.message });
        break;
      }
    }
    bytesDone += it.file.size;
  }
  onProgress({ done, total: items.length, bytesDone, bytesTotal, current: null });
  return { done, failed, tree };
}

export const SITE_STATE: Record<SiteDetail["state"], { line: "running" | "stopped" | "unhealthy"; label: string }> = {
  live: { line: "running", label: "Live" },
  off: { line: "stopped", label: "Offline" },
  draft: { line: "stopped", label: "Not published" },
  broken: { line: "unhealthy", label: "Not serving" },
};
