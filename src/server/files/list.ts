import "server-only";
import fs from "node:fs";
import path from "node:path";
import { all, now, run } from "../db";
import { AppError } from "../errors";
import { hostPath, isWithin } from "../host/paths";
import { listPins } from "../pins";
import type { User } from "../auth/users";
import type { FileEntry, Listing, SortKey } from "@/lib/files-types";
import { authorize, canSee, isTrashDirName, protectionReason, resolveHost, type Scope, type Target } from "./paths";
import { groupName, modeString, userName } from "./ids";
import { kindOf, mimeOf, previewOf } from "./kinds";
import { fsInfo, hostMounts, isVirtualFs } from "./mounts";

const MAX_ENTRIES = 250_000;
/** Above this many entries, size/date sorting (which needs a stat per entry) falls back to name. */
const STAT_ALL_LIMIT = 20_000;
const STAT_CONCURRENCY = 64;

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Run `fn` over items with bounded concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- entries

export interface EntryContext {
  scope: Scope;
  pins: Map<string, { id: string; label: string }>;
  sizes: Map<string, { bytes: number; computedAt: number }>;
}

export function pinMap(userId: string) {
  return new Map(listPins(userId, "folder").map((p) => [p.target, { id: p.id, label: p.label }]));
}

export function cachedSizes(reals: string[]): Map<string, { bytes: number; computedAt: number }> {
  const out = new Map<string, { bytes: number; computedAt: number }>();
  for (let i = 0; i < reals.length; i += 500) {
    const chunk = reals.slice(i, i + 500);
    if (!chunk.length) continue;
    let rows: { path: string; bytes: number; computed_at: number }[] = [];
    try {
      rows = all<{ path: string; bytes: number; computed_at: number }>(
      `SELECT path, bytes, computed_at FROM dir_sizes WHERE path IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
      );
    } catch {
      return out; // table not migrated yet
    }
    for (const r of rows) out.set(r.path, { bytes: r.bytes, computedAt: r.computed_at });
  }
  return out;
}

/**
 * Build the client view of one entry. `logical` is the path the person sees; `real` is where it
 * physically is (its parent resolved), and `st` is lstat of `real`.
 */
export async function toEntry(ctx: EntryContext, logical: string, real: string, st: fs.Stats): Promise<FileEntry> {
  const name = path.posix.basename(logical) || "/";
  let type: FileEntry["type"] = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other";
  let link: FileEntry["link"] = null;
  let size: number | null = st.isFile() ? st.size : null;
  let targetIsDir = false;
  let targetReal = real;
  if (st.isSymbolicLink()) {
    let target = "";
    try {
      target = await fs.promises.readlink(hostPath(real));
    } catch {
      /* unreadable */
    }
    let resolved: string | null = null;
    let ltype: "file" | "dir" | "other" | null = null;
    try {
      const r = await resolveHost(real);
      if (r.exists && r.stat) {
        resolved = r.real;
        ltype = r.stat.isDirectory() ? "dir" : r.stat.isFile() ? "file" : "other";
        if (r.stat.isFile()) size = r.stat.size;
        targetIsDir = r.stat.isDirectory();
        targetReal = r.real;
      }
    } catch {
      /* loop or permission: broken */
    }
    link = { target, resolved, type: ltype, broken: !resolved, outside: resolved ? !canSee(ctx.scope, resolved) : false };
    type = "symlink";
  }
  const isDir = st.isDirectory() || targetIsDir;
  const kind = kindOf(name, isDir);
  const pinned = isDir ? (ctx.pins.get(logical) ?? ctx.pins.get(targetReal) ?? null) : null;
  return {
    name,
    path: logical,
    type,
    link,
    size,
    mtime: Math.round(st.mtimeMs),
    mode: modeString(st.mode),
    perms: st.mode & 0o7777,
    uid: st.uid,
    gid: st.gid,
    owner: userName(st.uid),
    group: groupName(st.gid),
    hidden: name.startsWith("."),
    kind,
    mime: isDir ? null : mimeOf(name),
    preview: isDir ? null : previewOf(name, kind),
    dirSize: isDir ? (ctx.sizes.get(targetReal) ?? null) : null,
    pinned,
  };
}

// ---------------------------------------------------------------- listing

interface Raw {
  name: string;
  dir: boolean;
  link: boolean;
  other: boolean;
}

interface StatLite {
  size: number;
  mtime: number;
}

const statCache = new Map<string, { at: number; stats: Map<string, StatLite> }>();

async function statAll(dirReal: string, key: string, names: string[]): Promise<Map<string, StatLite>> {
  const hit = statCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.stats;
  const stats = new Map<string, StatLite>();
  await pool(names, STAT_CONCURRENCY, async (n) => {
    try {
      const s = await fs.promises.lstat(hostPath(path.posix.join(dirReal, n)));
      stats.set(n, { size: s.isFile() ? s.size : -1, mtime: s.mtimeMs });
    } catch {
      stats.set(n, { size: -1, mtime: 0 });
    }
  });
  statCache.set(key, { at: Date.now(), stats });
  if (statCache.size > 6) statCache.delete(statCache.keys().next().value!);
  return stats;
}

async function isDirLink(real: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(hostPath(real))).isDirectory();
  } catch {
    return false;
  }
}

export interface ListOptions {
  path: string;
  sort?: SortKey;
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
  hidden?: boolean;
  filter?: string;
  /** Folders first (the default), except when sorting by size, where folders compete by their measured size. */
  foldersFirst?: boolean;
  /** Only folders (and links to folders): for path completion and the breadcrumb menus. */
  only?: "dirs";
}

/** Keep the member's view anchored at their share even when they arrived through a link. */
export function displayPath(t: Target): string {
  if (t.scope.admin || isWithin(t.path, t.root.path)) return t.path;
  const rel = t.real === t.root.real ? "" : t.real.slice(t.root.real === "/" ? 0 : t.root.real.length);
  return (t.root.path + rel).replace(/\/+/g, "/") || "/";
}

export function breadcrumbs(t: Target, shown: string): { name: string; path: string }[] {
  if (t.scope.admin) {
    const crumbs = [{ name: "Computer", path: "/" }];
    let acc = "";
    for (const part of shown.split("/").filter(Boolean)) {
      acc += `/${part}`;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }
  const crumbs = [{ name: t.root.label, path: t.root.path }];
  let acc = t.root.path === "/" ? "" : t.root.path;
  const rest = shown === t.root.path ? "" : shown.slice(t.root.path.length);
  for (const part of rest.split("/").filter(Boolean)) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

export async function listDir(user: User, o: ListOptions): Promise<Listing> {
  const t = await authorize(user, o.path, "read");
  if (!t.stat?.isDirectory()) {
    throw new AppError("not_a_folder", `${path.posix.basename(t.path)} is a file, not a folder.`, 400, { type: "file" });
  }
  const shown = displayPath(t);
  const sort = o.sort ?? "name";
  const order = o.order ?? "asc";
  const offset = Math.max(0, o.offset ?? 0);
  const limit = Math.min(Math.max(1, o.limit ?? 200), 1000);
  const showHidden = o.hidden ?? false;
  const foldersFirst = o.foldersFirst ?? sort !== "size";
  const filter = o.filter?.trim().toLowerCase() || null;

  // Read names only (cheap even for 100k entries); stat just the page.
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(t.fsPath, { bufferSize: 512 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new AppError("forbidden", "The server isn't allowed to open this folder.", 403);
    throw e;
  }
  const raws: Raw[] = [];
  const counts = { dirs: 0, files: 0, links: 0, other: 0, hidden: 0 };
  let truncated = false;
  try {
    for await (const d of dir) {
      if (isTrashDirName(d.name)) continue;
      if (raws.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const hidden = d.name.startsWith(".");
      if (hidden) counts.hidden++;
      if (hidden && !showHidden) continue;
      if (filter && !d.name.toLowerCase().includes(filter)) continue;
      const r: Raw = { name: d.name, dir: d.isDirectory(), link: d.isSymbolicLink(), other: !d.isDirectory() && !d.isFile() && !d.isSymbolicLink() };
      if (o.only === "dirs" && !r.dir && !(r.link && (await isDirLink(path.posix.join(t.real, d.name))))) continue;
      if (r.dir) counts.dirs++;
      else if (r.link) counts.links++;
      else if (r.other) counts.other++;
      else counts.files++;
      raws.push(r);
    }
  } finally {
    // for-await closes the handle on completion; close explicitly after break.
    try {
      await dir.close();
    } catch {
      /* already closed */
    }
  }

  let sortLimited = false;
  let stats: Map<string, StatLite> | null = null;
  // Folders sort by their last measured size (from the dir_sizes cache), so the biggest things in a
  // full drive come first whether they are files or folders. Unmeasured folders sort as empty.
  let dirBytes: Map<string, { bytes: number }> | null = null;
  if ((sort === "size" || sort === "mtime") && raws.length > 0) {
    if (raws.length <= STAT_ALL_LIMIT) {
      stats = await statAll(t.real, `${t.real}:${t.stat.mtimeMs}:${t.stat.ino}:${showHidden}`, raws.map((r) => r.name));
      if (sort === "size") dirBytes = cachedSizes(raws.filter((r) => r.dir).map((r) => path.posix.join(t.real, r.name)));
    } else {
      sortLimited = true;
    }
  }
  // A drive mounted inside this folder counts as what's used on that drive: du stays on one
  // filesystem, so it would otherwise read as a few kilobytes.
  const mountPoints = new Set(hostMounts().filter((m) => !isVirtualFs(m.fstype)).map((m) => m.mount));
  const mountUsed = new Map<string, number | null>();
  const usedOn = (real: string): number | null => {
    if (!mountPoints.has(real)) return null;
    if (!mountUsed.has(real)) mountUsed.set(real, fsInfo(real)?.used ?? null);
    return mountUsed.get(real)!;
  };
  const sizeOf = (r: Raw) => {
    if (!r.dir) return stats!.get(r.name)?.size ?? -1;
    const real = path.posix.join(t.real, r.name);
    return usedOn(real) ?? dirBytes?.get(real)?.bytes ?? -1;
  };
  const effective: SortKey = sortLimited ? "name" : sort;
  const dirRank = (r: Raw) => (r.dir ? 0 : 1);
  const kindCache = new Map<string, string>();
  const kindKey = (r: Raw) => {
    let k = kindCache.get(r.name);
    if (!k) {
      k = r.dir ? "0" : kindOf(r.name);
      kindCache.set(r.name, k);
    }
    return k;
  };
  const dirMul = order === "desc" ? -1 : 1;
  raws.sort((a, b) => {
    if (foldersFirst) {
      const d = dirRank(a) - dirRank(b);
      if (d) return d;
    }
    let c = 0;
    switch (effective) {
      case "size":
        c = sizeOf(a) - sizeOf(b);
        break;
      case "mtime":
        c = (stats!.get(a.name)?.mtime ?? 0) - (stats!.get(b.name)?.mtime ?? 0);
        break;
      case "kind":
      case "type": {
        c = kindKey(a).localeCompare(kindKey(b));
        if (!c) {
          const ea = a.name.slice(a.name.lastIndexOf(".") + 1).toLowerCase();
          const eb = b.name.slice(b.name.lastIndexOf(".") + 1).toLowerCase();
          c = ea.localeCompare(eb);
        }
        break;
      }
    }
    if (!c) c = collator.compare(a.name, b.name);
    return c * dirMul;
  });

  const page = raws.slice(offset, offset + limit);
  const pins = pinMap(user.id);
  const childReals = page.filter((r) => r.dir).map((r) => path.posix.join(t.real, r.name));
  const ctx: EntryContext = { scope: t.scope, pins, sizes: cachedSizes([t.real, ...childReals]) };
  const entries = (
    await pool(page, 32, async (r) => {
      const real = path.posix.join(t.real, r.name);
      try {
        const st = await fs.promises.lstat(hostPath(real));
        return await toEntry(ctx, shown === "/" ? `/${r.name}` : `${shown}/${r.name}`, real, st);
      } catch {
        return null; // vanished between readdir and stat
      }
    })
  ).filter((e): e is FileEntry => !!e);

  for (const e of entries) {
    if (e.type !== "dir") continue;
    const used = usedOn(path.posix.join(t.real, e.name));
    if (used !== null) e.dirSize = { bytes: used, computedAt: Date.now() };
  }

  const self = await toEntry(ctx, shown, t.real, t.stat);
  if (offset === 0) rememberVisit(user.id, shown);

  const atTop = t.scope.admin ? shown === "/" : shown === t.root.path;
  return {
    path: shown,
    real: t.real,
    name: shown === "/" ? "Computer" : atTop ? t.root.label : path.posix.basename(shown),
    parent: atTop ? null : path.posix.dirname(shown),
    breadcrumbs: breadcrumbs(t, shown),
    access: t.access,
    self,
    entries,
    total: raws.length,
    offset,
    limit,
    counts,
    sort: effective,
    order,
    sortLimited,
    truncated,
    fs: fsInfo(t.real),
    protectedReason: t.access === "write" ? await protectionReason(t.real) : null,
  };
}

/** Details for a single file or folder. */
export async function statPath(user: User, p: string): Promise<FileEntry & { real: string; access: Listing["access"]; fs: Listing["fs"]; protectedReason: string | null }> {
  // Don't follow the last link: show the link itself (with its target) like a listing does.
  const t = await authorize(user, p, "read", { followLast: false });
  const shown = displayPath(t);
  const ctx: EntryContext = { scope: t.scope, pins: pinMap(user.id), sizes: cachedSizes([t.real]) };
  const e = await toEntry(ctx, shown, t.real, t.stat!);
  return { ...e, real: t.real, access: t.access, fs: fsInfo(t.real), protectedReason: t.access === "write" ? await protectionReason(t.real) : null };
}

// ---------------------------------------------------------------- recents

const lastVisit = new Map<string, number>();

function rememberVisit(userId: string, p: string) {
  const key = `${userId}\0${p}`;
  const t = now();
  if ((lastVisit.get(key) ?? 0) > t - 60_000) return;
  lastVisit.set(key, t);
  if (lastVisit.size > 5000) lastVisit.clear();
  try {
    run(
      "INSERT INTO file_recents (user_id, path, visited_at) VALUES (?, ?, ?) ON CONFLICT(user_id, path) DO UPDATE SET visited_at = excluded.visited_at",
      userId,
      p,
      t,
    );
    run(
      "DELETE FROM file_recents WHERE user_id = ? AND path NOT IN (SELECT path FROM file_recents WHERE user_id = ? ORDER BY visited_at DESC LIMIT 30)",
      userId,
      userId,
    );
  } catch {
    /* table missing until the migration is applied: recents are a nicety */
  }
}

export function recentFolders(userId: string, limit = 12): { path: string; visitedAt: number }[] {
  try {
    return all<{ path: string; visited_at: number }>("SELECT path, visited_at FROM file_recents WHERE user_id = ? ORDER BY visited_at DESC LIMIT ?", userId, limit).map((r) => ({
      path: r.path,
      visitedAt: r.visited_at,
    }));
  } catch {
    return [];
  }
}
