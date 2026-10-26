import "server-only";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { all, DATA_DIR, now, one, run } from "../db";
import { id as newId } from "../crypto";
import { AppError, badRequest, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import { hostPath } from "../host/paths";
import { findById, toUser } from "../auth/users";
import type { User } from "../auth/users";
import type { ConflictPolicy, UploadSession } from "@/lib/files-types";
import { formatBytes } from "@/lib/format";
import { assertMutable, assertRemovable, authorize, cleanName, freeName } from "./paths";
import { containerToHost, freeBytes, localFreeBytes, mountOf } from "./mounts";
import { moveToTrash } from "./trash";
import { inDir, openFileIn } from "./safe";
import { displayPath } from "./list";

/**
 * Resumable chunked uploads: init → PUT chunks at an offset → complete. Chunks land in
 * /data/uploads/<id>/data; a dropped connection loses at most the chunk in flight, and the client
 * asks GET /uploads/<id> where to resume. Completion moves the file into place atomically (rename
 * when the upload area shares the destination's filesystem, else copy + fsync + rename) and gives
 * it to the owner of the destination folder.
 */

export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_SIZE = 1024 ** 5; // 1 PiB: effectively "whatever fits"
const EXPIRE_MS = 48 * 3600_000;

type Where = { ip: string; zone: string };

interface Row {
  id: string;
  user_id: string;
  dest_dir: string;
  name: string;
  size: number;
  received: number;
  conflict: ConflictPolicy;
  mtime: number | null;
  status: UploadSession["status"];
  final_path: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const toSession = (r: Row): UploadSession => ({
  id: r.id,
  dir: r.dest_dir,
  name: r.name,
  size: r.size,
  received: r.received,
  conflict: r.conflict,
  status: r.status,
  finalPath: r.final_path,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  chunkSize: CHUNK_SIZE,
});

const tempDir = (id: string) => path.join(UPLOAD_DIR, id);
const tempFile = (id: string) => path.join(UPLOAD_DIR, id, "data");

function load(user: Pick<User, "id" | "role">, id: string): Row {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw notFound("That upload");
  const r = one<Row>("SELECT * FROM uploads WHERE id = ?", id);
  if (!r || (r.user_id !== user.id && user.role !== "admin")) throw notFound("That upload");
  return r;
}

function update(id: string, patch: Partial<Pick<Row, "received" | "status" | "final_path" | "error">>) {
  const cols = Object.keys(patch);
  run(`UPDATE uploads SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...cols.map((c) => patch[c as keyof typeof patch]), now(), id);
  const r = one<Row>("SELECT * FROM uploads WHERE id = ?", id);
  if (r) publish("files.uploads", { userId: r.user_id, upload: toSession(r) });
}

/** Bytes still expected by open uploads (reserved space in the upload area). */
function reserved(): number {
  return one<{ n: number | null }>("SELECT SUM(size - received) AS n FROM uploads WHERE status IN ('open', 'completing')")?.n ?? 0;
}

export async function initUpload(
  user: User,
  input: { dir: string; name: string; size: number; lastModified?: number | null; conflict: ConflictPolicy },
): Promise<UploadSession & { exists: boolean }> {
  const name = cleanName(input.name, "file name");
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_SIZE) throw badRequest("That file size doesn't look right.");
  const dir = await authorize(user, input.dir, "write");
  if (!dir.stat?.isDirectory()) throw new AppError("not_a_folder", "Choose a folder to upload into.", 400);
  await assertMutable(dir.real, "upload into");
  const target = path.posix.join(dir.real, name);
  let exists: fs.Stats | null = null;
  try {
    exists = await fs.promises.lstat(hostPath(target));
  } catch {
    /* free */
  }
  if (exists?.isDirectory() && input.conflict === "overwrite") throw new AppError("conflict", `A folder called ${name} is already here, so the file can't replace it.`, 409);

  const free = freeBytes(dir.real);
  if (free !== null && input.size > free) {
    throw new AppError("no_space", `${name} is ${formatBytes(input.size)} but ${mountOf(dir.real)?.mount ?? "that drive"} only has ${formatBytes(free)} free.`, 507, { free, size: input.size });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const localFree = localFreeBytes(UPLOAD_DIR);
  if (localFree !== null && input.size + reserved() > localFree) {
    throw new AppError("no_space", `Gluon's upload area only has ${formatBytes(Math.max(0, localFree - reserved()))} free, and ${name} is ${formatBytes(input.size)}. Free up space on the drive that holds Gluon's data, or upload fewer files at once.`, 507);
  }

  const id = newId(12);
  fs.mkdirSync(tempDir(id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempFile(id), "", { mode: 0o600 });
  const t = now();
  run(
    `INSERT INTO uploads (id, user_id, dest_dir, name, size, received, conflict, mtime, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'open', ?, ?)`,
    id,
    user.id,
    displayPath(dir),
    name,
    input.size,
    input.conflict,
    input.lastModified && Number.isFinite(input.lastModified) ? Math.round(input.lastModified) : null,
    t,
    t,
  );
  return { ...toSession(load(user, id)), exists: !!exists };
}

export function getUpload(user: User, id: string): UploadSession {
  const r = load(user, id);
  // The file on disk is the truth for resuming (a crash may have lost the last unsynced bytes).
  if (r.status === "open") {
    try {
      const size = fs.statSync(tempFile(id)).size;
      if (size < r.received) {
        update(id, { received: size });
        r.received = size;
      }
    } catch {
      update(id, { status: "failed", error: "The partial upload was lost. Start it again." });
      return toSession(load(user, id));
    }
  }
  return toSession(r);
}

export function listUploads(user: User): UploadSession[] {
  return all<Row>("SELECT * FROM uploads WHERE user_id = ? AND (status IN ('open', 'completing') OR updated_at > ?) ORDER BY created_at DESC LIMIT 100", user.id, now() - 3600_000).map(toSession);
}

const locks = new Set<string>();

/** Write one chunk at `offset`. Offsets may repeat already-received data (safe retries). */
export async function putChunk(user: User, id: string, offset: number, body: ReadableStream<Uint8Array> | null): Promise<{ received: number; size: number }> {
  const r = load(user, id);
  if (r.status !== "open") throw new AppError("closed", r.status === "done" ? "That upload has already finished." : "That upload was stopped. Start it again.", 409, { status: r.status });
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest("Missing or invalid offset.");
  if (!body) throw badRequest("The chunk was empty.");
  if (locks.has(id)) throw new AppError("busy", "That upload is already receiving data. Wait for the current chunk.", 409);
  let onDisk: number;
  try {
    onDisk = fs.statSync(tempFile(id)).size;
  } catch {
    update(id, { status: "failed", error: "The partial upload was lost. Start it again." });
    throw new AppError("lost", "The partial upload was lost. Start it again.", 410);
  }
  const received = Math.min(r.received, onDisk);
  if (offset > received) throw new AppError("offset", `Expected data from byte ${received}.`, 409, { received });

  locks.add(id);
  let written = 0;
  const fh = await fs.promises.open(tempFile(id), "r+");
  try {
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (written + value.length > MAX_CHUNK) {
        await reader.cancel().catch(() => {});
        throw new AppError("chunk_too_large", `Chunks can be ${formatBytes(MAX_CHUNK)} at most.`, 413);
      }
      if (offset + written + value.length > r.size) {
        await reader.cancel().catch(() => {});
        throw new AppError("too_much", "More data arrived than the file's size.", 413);
      }
      let pos = 0;
      while (pos < value.length) {
        const { bytesWritten } = await fh.write(value, pos, value.length - pos, offset + written + pos);
        pos += bytesWritten;
      }
      written += value.length;
    }
  } catch (e) {
    // Keep what arrived before the connection dropped: it's contiguous from `offset`.
    if (!(e instanceof AppError)) console.warn(`[gluon] upload ${id} chunk interrupted after ${written} bytes`);
    throw e instanceof AppError ? e : new AppError("interrupted", "The connection dropped during the upload. It will resume from where it stopped.", 499);
  } finally {
    await fh.close().catch(() => {});
    const next = Math.max(received, offset + written);
    if (next !== r.received) update(id, { received: next });
    locks.delete(id);
  }
  const next = Math.max(received, offset + written);
  return { received: next, size: r.size };
}

export function cancelUpload(user: User, id: string) {
  const r = load(user, id);
  if (r.status === "completing") throw new AppError("busy", "That upload is being saved and can't be cancelled now.", 409);
  if (r.status === "open") update(id, { status: "cancelled" });
  fs.rmSync(tempDir(id), { recursive: true, force: true });
}

const finishing = new Map<string, Promise<UploadSession>>();

/**
 * Put the finished upload in place. Resolves with the final session if that takes under ~20 s;
 * otherwise returns status "completing" and the client polls GET /uploads/<id>.
 */
export async function completeUpload(user: User, id: string, where: Where): Promise<UploadSession> {
  const r = load(user, id);
  if (r.status === "done" || r.status === "skipped") return toSession(r);
  if (r.status === "completing" && finishing.has(id)) return race(id, finishing.get(id)!);
  if (r.status !== "open" && r.status !== "completing") throw new AppError("closed", "That upload was stopped. Start it again.", 409);
  let onDisk = 0;
  try {
    onDisk = fs.statSync(tempFile(id)).size;
  } catch {
    update(id, { status: "failed", error: "The partial upload was lost. Start it again." });
    throw new AppError("lost", "The partial upload was lost. Start it again.", 410);
  }
  if (onDisk !== r.size || r.received !== r.size) {
    throw new AppError("incomplete", `Only ${formatBytes(Math.min(onDisk, r.received))} of ${formatBytes(r.size)} arrived. Send the rest first.`, 409, { received: Math.min(onDisk, r.received) });
  }
  update(id, { status: "completing" });
  const owner = findById(r.user_id);
  const actor = owner ? toUser(owner) : user;
  const p = finalize(actor, r, where)
    .catch((e) => {
      const msg = e instanceof AppError ? e.message : (e as Error).message?.replace(/\/proc\/1\/root/g, "") || "Couldn't save the upload.";
      // Leave the data in place so the person can retry completion (e.g. after freeing space).
      update(id, { status: "open", error: msg });
      audit(actor, { action: "files.upload", summary: `Upload of ${r.name} failed`, target: r.dest_dir, detail: { error: msg }, outcome: "failed" }, where);
      throw e;
    })
    .finally(() => finishing.delete(id));
  finishing.set(id, p);
  return race(id, p);
}

async function race(id: string, p: Promise<UploadSession>): Promise<UploadSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((res) => (timer = setTimeout(() => res(null), 20_000)));
  const out = await Promise.race([p, slow]).finally(() => clearTimeout(timer));
  if (out) return out;
  p.catch(() => {});
  // Still copying: report the row as it stands ("completing"); the client polls.
  return toSession(one<Row>("SELECT * FROM uploads WHERE id = ?", id)!);
}

async function finalize(user: User, r: Row, where: Where): Promise<UploadSession> {
  const dir = await authorize(user, r.dest_dir, "write");
  if (!dir.stat?.isDirectory()) throw new AppError("not_a_folder", `${r.dest_dir} isn't a folder any more.`, 409);
  await assertMutable(dir.real, "upload into");
  const owner = dir.stat;
  // Everything below happens inside the destination opened without following links (and checked
  // to be the folder that was authorised), so a folder on the way swapped for a link can't redirect it.
  return inDir(dir.real, dir.stat, async (d) => {
    let name = r.name;
    let target = path.posix.join(dir.real, name);
    const existing = await fs.promises.lstat(d.at(name)).catch(() => null);
    if (existing) {
      if (r.conflict === "skip") {
        fs.rmSync(tempDir(r.id), { recursive: true, force: true });
        update(r.id, { status: "skipped", final_path: null, error: null });
        return toSession(one<Row>("SELECT * FROM uploads WHERE id = ?", r.id)!);
      }
      if (r.conflict === "rename") {
        name = await freeName(dir.real, name);
        target = path.posix.join(dir.real, name);
      } else {
        if (existing.isDirectory()) throw new AppError("conflict", `A folder called ${name} is already here, so the file can't replace it.`, 409);
        await assertRemovable({ real: target, root: dir.root, scope: dir.scope }, "replace");
        // Overwrite = the old file goes to the trash, never silently lost.
        await moveToTrash(target, user.id, existing);
      }
    }

    const src = tempFile(r.id);
    const hostSrc = containerToHost(src, dir.real);
    const sameMount = !!hostSrc && mountOf(hostSrc)?.mount === mountOf(dir.real)?.mount;
    // The file, next to the target, ready to link or rename into place: Gluon's own temp file on the
    // same drive, or a copy written into the destination.
    const stagedName = `.gluon-upload-${r.id}`;
    let staged: string;
    if (sameMount) {
      staged = hostPath(hostSrc!);
    } else {
      const free = freeBytes(dir.real);
      if (free !== null && r.size > free) throw new AppError("no_space", `${mountOf(dir.real)?.mount ?? "The drive"} only has ${formatBytes(free)} free; ${r.name} needs ${formatBytes(r.size)}.`, 507);
      staged = d.at(stagedName);
      const out = await openFileIn(d, stagedName, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      try {
        await pipeline(fs.createReadStream(src, { highWaterMark: 1024 * 1024 }), fs.createWriteStream("", { fd: out.fd, autoClose: false, emitClose: false }));
        await out.sync();
      } finally {
        await out.close().catch(() => {});
      }
    }
    try {
      // Owner, mode and time are set on the open file, never through a path someone could swap.
      const fh = await fs.promises.open(staged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        await fh.chmod(0o644);
        await fh.chown(owner.uid, owner.gid).catch(() => {});
        if (r.mtime) await fh.utimes(new Date(), new Date(r.mtime)).catch(() => {});
      } finally {
        await fh.close().catch(() => {});
      }
      if (r.conflict === "overwrite") {
        await fs.promises.rename(staged, d.at(name));
      } else {
        // No-clobber: link() fails if the name was taken meanwhile; pick another name then.
        for (let attempt = 0; ; attempt++) {
          try {
            await fs.promises.link(staged, d.at(name));
            await fs.promises.unlink(staged);
            break;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EEXIST" && attempt < 5) {
              name = await freeName(dir.real, r.name);
              target = path.posix.join(dir.real, name);
              continue;
            }
            if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
              // Filesystems without hard links (vfat/exfat): fall back to rename.
              await fs.promises.rename(staged, d.at(name));
              break;
            }
            throw e;
          }
        }
      }
    } catch (e) {
      if (!sameMount) await fs.promises.unlink(d.at(stagedName)).catch(() => {});
      throw e;
    }
    // Make the new directory entry durable.
    await d.sync();
    fs.rmSync(tempDir(r.id), { recursive: true, force: true });
    const finalPath = path.posix.join(r.dest_dir, name);
    update(r.id, { status: "done", final_path: finalPath, error: null });
    audit(user, { action: "files.upload", summary: `Uploaded ${name} (${formatBytes(r.size)})`, target: target, detail: { size: r.size, dir: dir.real, renamed: name !== r.name, replaced: !!existing && r.conflict === "overwrite" } }, where);
    return toSession(one<Row>("SELECT * FROM uploads WHERE id = ?", r.id)!);
  });
}

/** Expire abandoned uploads and remove temp folders nobody owns. */
export function cleanupUploads(startup = false) {
  let rows: Row[];
  try {
    if (startup) {
      // A restart during completion: the data is still in the upload area, so let the client retry.
      run("UPDATE uploads SET status = 'open', error = 'Gluon restarted while saving this upload. Try finishing it again.' WHERE status = 'completing'");
    }
    for (const r of all<Row>("SELECT * FROM uploads WHERE status = 'open' AND updated_at < ?", now() - EXPIRE_MS)) {
      fs.rmSync(tempDir(r.id), { recursive: true, force: true });
      run("UPDATE uploads SET status = 'expired', updated_at = ? WHERE id = ?", now(), r.id);
    }
    run("DELETE FROM uploads WHERE status NOT IN ('open', 'completing') AND updated_at < ?", now() - 30 * 86_400_000);
    rows = all<Row>("SELECT * FROM uploads WHERE status IN ('open', 'completing')");
  } catch {
    return; // table not migrated yet
  }
  const keep = new Set(rows.map((r) => r.id));
  let names: string[] = [];
  try {
    names = fs.readdirSync(UPLOAD_DIR);
  } catch {
    return;
  }
  for (const n of names) {
    if (!keep.has(n)) fs.rmSync(path.join(UPLOAD_DIR, n), { recursive: true, force: true });
  }
}

