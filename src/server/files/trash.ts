import "server-only";
import fs from "node:fs";
import path from "node:path";
import { all, now, one, run } from "../db";
import { id as newId } from "../crypto";
import { AppError, forbidden, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import type { User } from "../auth/users";
import type { FileJob, TrashItem, TrashSummary } from "@/lib/files-types";
import { formatBytes, plural } from "@/lib/format";
import { assertMutable, assertRemovable, authorize, freeName, isTrashDirName, resolveHost, scopeFor, TRASH_DIR, accessFor } from "./paths";
import { hostMounts, isVirtualFs, mountOf, mountsBelow } from "./mounts";
import { startJob } from "./jobs";
import { measureQuiet } from "./du";

/**
 * Trash lives on the same filesystem as the thing deleted — `<mount root>/.gluon-trash/<id>/<name>` —
 * so trashing is an instant rename and never needs free space. Each item also gets a sidecar
 * `<id>.json` so the trash can be rebuilt from disk if the database is lost (or another Gluon
 * instance trashed it).
 */

interface Row {
  id: string;
  original_path: string;
  trash_path: string;
  fs_root: string;
  size: number | null;
  is_dir: number;
  deleted_at: number;
  deleted_by: string | null;
}

interface Sidecar {
  id: string;
  originalPath: string;
  name: string;
  isDir: boolean;
  size: number | null;
  deletedAt: number;
  deletedBy: string | null;
}

function trashRoot(mount: string) {
  return path.posix.join(mount, TRASH_DIR);
}

/** Make sure `<mount>/.gluon-trash` is a real root-owned directory (never a link someone planted). */
async function ensureTrashDir(mount: string): Promise<string> {
  const dir = trashRoot(mount);
  const fsDir = hostPath(dir);
  try {
    await fs.promises.mkdir(fsDir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EROFS") throw new AppError("read_only", `${mount} is mounted read-only, so nothing on it can be moved to the trash.`, 409);
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = await fs.promises.lstat(fsDir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new AppError("trash_broken", `${dir} isn't a normal folder, so Gluon won't use it as the trash. Remove it by hand and try again.`, 409);
  }
  if (st.uid !== 0) await fs.promises.chown(fsDir, 0, 0).catch(() => {});
  if ((st.mode & 0o777) !== 0o700) await fs.promises.chmod(fsDir, 0o700).catch(() => {});
  return dir;
}

function cachedSize(real: string): number | null {
  try {
    return one<{ bytes: number }>("SELECT bytes FROM dir_sizes WHERE path = ?", real)?.bytes ?? null;
  } catch {
    return null;
  }
}

/**
 * Move one resolved path to its filesystem's trash. Callers have already authorised and checked
 * removability. Returns the new trash row.
 */
export async function moveToTrash(real: string, userId: string | null): Promise<TrashItem> {
  const m = mountOf(real);
  if (!m) throw new AppError("no_mount", "Couldn't work out which drive that's on.", 500);
  if (m.readOnly) throw new AppError("read_only", `${m.mount} is mounted read-only, so nothing on it can be moved to the trash.`, 409);
  const st = await fs.promises.lstat(hostPath(real));
  const dir = await ensureTrashDir(m.mount);
  const id = newId();
  const itemDir = path.posix.join(dir, id);
  const name = path.posix.basename(real);
  const dest = path.posix.join(itemDir, name);
  const isDir = st.isDirectory();
  const size = isDir ? cachedSize(real) : st.size;
  const side: Sidecar = { id, originalPath: real, name, isDir, size, deletedAt: now(), deletedBy: userId };
  await fs.promises.mkdir(hostPath(itemDir), { mode: 0o700 });
  try {
    await fs.promises.rename(hostPath(real), hostPath(dest));
  } catch (e) {
    await fs.promises.rmdir(hostPath(itemDir)).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EXDEV") throw new AppError("cross_device", `${real} sits on a different drive than its folder, so it can't be moved to the trash.`, 409);
    if (code === "EBUSY") throw new AppError("busy", `${real} is in use (probably a mount point), so it can't be moved to the trash.`, 409);
    throw e;
  }
  await fs.promises.writeFile(hostPath(path.posix.join(dir, `${id}.json`)), JSON.stringify(side), { mode: 0o600 }).catch(() => {});
  run(
    "INSERT INTO trash (id, original_path, trash_path, fs_root, size, is_dir, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    real,
    dest,
    m.mount,
    size,
    isDir ? 1 : 0,
    side.deletedAt,
    userId,
  );
  if (isDir && size === null) {
    // Measure in the background so the trash can show how much space it holds.
    void measureQuiet(dest).then((bytes) => {
      if (bytes !== null) {
        run("UPDATE trash SET size = ? WHERE id = ?", bytes, id);
        publish("files.trash", { id, change: "sized" });
      }
    });
  }
  publish("files.trash", { id, change: "added" });
  return toItem({ id, original_path: real, trash_path: dest, fs_root: m.mount, size, is_dir: isDir ? 1 : 0, deleted_at: side.deletedAt, deleted_by: userId }, true, false);
}

function usernameOf(id: string | null): string | null {
  if (!id) return null;
  return one<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", id)?.display_name ?? null;
}

function toItem(r: Row, present: boolean, originalTaken: boolean): TrashItem {
  return {
    id: r.id,
    name: path.posix.basename(r.original_path),
    originalPath: r.original_path,
    trashPath: r.trash_path,
    fsRoot: r.fs_root,
    size: r.size,
    isDir: !!r.is_dir,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
    deletedByName: usernameOf(r.deleted_by),
    present,
    originalTaken,
  };
}

async function exists(p: string) {
  try {
    await fs.promises.lstat(hostPath(p));
    return true;
  } catch {
    return false;
  }
}

/** Trash several paths for a person. Stops at the first refusal so nothing half-happens silently. */
export async function trashPaths(user: User, paths: string[], where: { ip: string; zone: string }): Promise<{ items: TrashItem[] }> {
  const scope = await scopeFor(user);
  const targets: Awaited<ReturnType<typeof authorize>>[] = [];
  for (const p of paths) {
    // Don't follow the last link: trashing a link removes the link, not what it points at.
    const t = await authorize(user, p, "write", { scope, followLast: false });
    await assertRemovable(t, "move to the trash");
    targets.push(t);
  }
  // Drop entries already inside another selected folder.
  const unique = targets.filter((t) => !targets.some((o) => o !== t && o.real !== t.real && isWithin(t.real, o.real)));
  const items: TrashItem[] = [];
  for (const t of unique) {
    try {
      items.push(await moveToTrash(t.real, user.id));
    } catch (e) {
      if (items.length) {
        audit(user, { action: "files.trash", summary: `Moved ${plural(items.length, "item")} to the trash`, target: path.posix.dirname(unique[0]!.real), detail: { paths: items.map((i) => i.originalPath) } }, where);
      }
      throw e;
    }
  }
  const summary = items.length === 1 ? `Moved ${items[0]!.name} to the trash` : `Moved ${plural(items.length, "item")} to the trash`;
  audit(user, { action: "files.trash", summary, target: items.length === 1 ? items[0]!.originalPath : path.posix.dirname(unique[0]?.real ?? "/"), detail: { paths: items.map((i) => i.originalPath), ids: items.map((i) => i.id) } }, where);
  return { items };
}

export async function listTrash(user: User): Promise<TrashSummary> {
  const rows =
    user.role === "admin"
      ? all<Row>("SELECT * FROM trash ORDER BY deleted_at DESC")
      : all<Row>("SELECT * FROM trash WHERE deleted_by = ? ORDER BY deleted_at DESC", user.id);
  const items = await Promise.all(rows.map(async (r) => toItem(r, await exists(r.trash_path), await exists(r.original_path))));
  const by = new Map<string, { fsRoot: string; bytes: number; items: number }>();
  for (const i of items) {
    if (!i.present) continue;
    const e = by.get(i.fsRoot) ?? { fsRoot: i.fsRoot, bytes: 0, items: 0 };
    e.bytes += i.size ?? 0;
    e.items++;
    by.set(i.fsRoot, e);
  }
  return { items, byFilesystem: [...by.values()].sort((a, b) => b.bytes - a.bytes) };
}

export async function restore(
  user: User,
  ids: string[],
  onConflict: "rename" | "fail",
  where: { ip: string; zone: string },
): Promise<{ restored: { id: string; path: string }[] }> {
  const scope = await scopeFor(user);
  const restored: { id: string; path: string }[] = [];
  for (const id of ids) {
    const r = one<Row>("SELECT * FROM trash WHERE id = ?", id);
    if (!r) throw notFound("That trash item");
    if (user.role !== "admin" && r.deleted_by !== user.id) throw forbidden("Only the person who deleted it (or an admin) can restore it.");
    if (!(await exists(r.trash_path))) {
      run("DELETE FROM trash WHERE id = ?", id);
      throw new AppError("gone", `${path.posix.basename(r.original_path)} is no longer in the trash (it was removed outside Gluon).`, 410);
    }
    const parentPath = path.posix.dirname(r.original_path);
    // Find (or rebuild) the original folder.
    const parent = await resolveHost(parentPath);
    if (!scope.admin) {
      const acc = accessFor(scope, parent.real);
      if (!acc || acc.access !== "write") throw forbidden("You no longer have write access to where that came from.");
    }
    await assertMutable(parent.real, "restore into");
    if (!parent.exists) {
      await fs.promises.mkdir(hostPath(parent.real), { recursive: true, mode: 0o755 });
    }
    let name = path.posix.basename(r.original_path);
    if (await exists(path.posix.join(parent.real, name))) {
      if (onConflict === "fail") {
        throw new AppError("conflict", `Something called ${name} is already back in ${parentPath}. Restore it with a different name?`, 409, { id, originalPath: r.original_path });
      }
      name = await freeName(parent.real, name, "restored");
    }
    const dest = path.posix.join(parent.real, name);
    try {
      await fs.promises.rename(hostPath(r.trash_path), hostPath(dest));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        throw new AppError("cross_device", `${parentPath} is now on a different drive than the trash, so ${name} can't be put back automatically.`, 409);
      }
      throw e;
    }
    const trashDir = path.posix.dirname(path.posix.dirname(r.trash_path));
    await fs.promises.rmdir(hostPath(path.posix.dirname(r.trash_path))).catch(() => {});
    await fs.promises.unlink(hostPath(path.posix.join(trashDir, `${id}.json`))).catch(() => {});
    run("DELETE FROM trash WHERE id = ?", id);
    restored.push({ id, path: dest });
    publish("files.trash", { id, change: "restored" });
  }
  if (restored.length) {
    audit(user, { action: "files.restore", summary: restored.length === 1 ? `Restored ${path.posix.basename(restored[0]!.path)} from the trash` : `Restored ${plural(restored.length, "item")} from the trash`, target: restored[0]!.path, detail: { restored } }, where);
  }
  return { restored };
}

/** Permanently delete trash items (admin). Runs as a job: big folders take a while. */
export function deleteForever(user: User, ids: string[] | "all", where: { ip?: string; zone?: string }): FileJob {
  const rows = ids === "all" ? all<Row>("SELECT * FROM trash") : ids.map((id) => one<Row>("SELECT * FROM trash WHERE id = ?", id)).filter((r): r is Row => !!r);
  if (!rows.length) throw new AppError("empty", ids === "all" ? "The trash is already empty." : "Those items are no longer in the trash.", 409);
  const bytes = rows.reduce((a, r) => a + (r.size ?? 0), 0);
  const title = ids === "all" ? "Empty the trash" : rows.length === 1 ? `Delete ${path.posix.basename(rows[0]!.original_path)} forever` : `Delete ${plural(rows.length, "item")} forever`;
  return startJob(
    user,
    "delete-forever",
    title,
    { ids: rows.map((r) => r.id) },
    where,
    async (ctx) => {
      ctx.progress({ phase: "Deleting", total: rows.length, bytesTotal: bytes || null });
      let done = 0;
      let freed = 0;
      for (const r of rows) {
        ctx.check();
        ctx.progress({ current: r.original_path });
        const itemDir = path.posix.dirname(r.trash_path);
        const trashDir = path.posix.dirname(itemDir);
        // Paranoia: only ever delete inside a .gluon-trash folder, and never across a mount.
        if (!isTrashDirName(path.posix.basename(trashDir)) || path.posix.basename(itemDir) !== r.id) {
          throw new AppError("unsafe", `Refusing to delete ${r.trash_path}: it doesn't look like a trash item.`, 500);
        }
        if (mountsBelow(itemDir).length) throw new AppError("unsafe", `Something is mounted inside ${itemDir}; unmount it first.`, 409);
        await fs.promises.rm(hostPath(itemDir), { recursive: true, force: true, maxRetries: 2 });
        await fs.promises.unlink(hostPath(path.posix.join(trashDir, `${r.id}.json`))).catch(() => {});
        run("DELETE FROM trash WHERE id = ?", r.id);
        publish("files.trash", { id: r.id, change: "deleted" });
        done++;
        freed += r.size ?? 0;
        ctx.progress({ done, bytesDone: freed });
      }
      return {
        message: ids === "all" ? `Emptied the trash${freed ? ` and freed ${formatBytes(freed)}` : ""}` : `Deleted ${plural(done, "item")} forever${freed ? ` (${formatBytes(freed)})` : ""}`,
        result: { deleted: done, bytes: freed },
      };
    },
    { action: "files.delete_forever", target: rows.length === 1 ? rows[0]!.original_path : null },
  );
}

/** Bring the trash table in line with what's on disk (imports sidecars, drops vanished items). */
export async function reconcileTrash() {
  const seen = new Set<string>();
  const mounts = hostMounts().filter((m) => !isVirtualFs(m.fstype) && !m.readOnly);
  const known = new Set(all<{ id: string }>("SELECT id FROM trash").map((r) => r.id));
  for (const m of mounts) {
    const key = `${m.dev}:${m.root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = trashRoot(m.mount);
    let names: string[];
    try {
      const st = await fs.promises.lstat(hostPath(dir));
      if (!st.isDirectory()) continue;
      names = await fs.promises.readdir(hostPath(dir));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const id = n.slice(0, -5);
      if (known.has(id)) continue;
      try {
        const side = JSON.parse(await fs.promises.readFile(hostPath(path.posix.join(dir, n)), "utf8")) as Sidecar;
        const tp = path.posix.join(dir, id, side.name);
        if (side.id !== id || !(await exists(tp))) continue;
        normalizeHostPath(side.originalPath);
        run(
          "INSERT OR IGNORE INTO trash (id, original_path, trash_path, fs_root, size, is_dir, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          side.originalPath,
          tp,
          m.mount,
          side.size,
          side.isDir ? 1 : 0,
          side.deletedAt,
          one<{ id: string }>("SELECT id FROM users WHERE id = ?", side.deletedBy ?? "")?.id ?? null,
        );
      } catch {
        /* unreadable sidecar: leave it */
      }
    }
  }
  for (const r of all<Row>("SELECT * FROM trash")) {
    if (!(await exists(r.trash_path))) run("DELETE FROM trash WHERE id = ?", r.id);
  }
}

/** Bytes in the trash per filesystem (for the "trash is holding N GB" finding). */
export function trashTotals(): { fsRoot: string; bytes: number; items: number }[] {
  return all<{ fs_root: string; bytes: number; items: number }>("SELECT fs_root, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS items FROM trash GROUP BY fs_root").map((r) => ({
    fsRoot: r.fs_root,
    bytes: r.bytes,
    items: r.items,
  }));
}

