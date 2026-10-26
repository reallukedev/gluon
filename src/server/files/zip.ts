import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { ZipArchive } from "archiver";
import { badRequest, notFound } from "../errors";
import { hostPath, isWithin } from "../host/paths";
import { token as newToken } from "../crypto";
import type { User } from "../auth/users";
import type { ZipEstimate } from "@/lib/files-types";
import { formatBytes, plural } from "@/lib/format";
import { authorize, isTrashDirName, scopeFor } from "./paths";
import { isCompressed } from "./kinds";
import { disposition } from "./stream";

/**
 * Folder downloads as a streamed zip. The client first asks for an estimate (POST) which also
 * returns a short-lived token; the download itself is a plain GET with that token so the browser's
 * own download manager handles it. Links are stored as links, never followed.
 */

const TOKEN_MS = 15 * 60_000;
const ESTIMATE_MS = 8000;
const ESTIMATE_MAX = 300_000;
const WARN_BYTES = 4 * 1024 ** 3;
const WARN_FILES = 50_000;

interface Pending {
  userId: string;
  name: string;
  items: { real: string; name: string }[];
  expires: number;
  bytes: number;
  files: number;
}

type G = typeof globalThis & { __gluonZips?: Map<string, Pending> };
const g = globalThis as G;
const pending = () => (g.__gluonZips ??= new Map());

function sweep() {
  const t = Date.now();
  for (const [k, v] of pending()) if (v.expires < t) pending().delete(k);
}

async function measure(items: { real: string }[]) {
  const deadline = Date.now() + ESTIMATE_MS;
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let partial = false;
  const stack = items.map((i) => i.real);
  while (stack.length) {
    if (files + dirs > ESTIMATE_MAX || Date.now() > deadline) {
      partial = true;
      break;
    }
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(hostPath(cur));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      dirs++;
      try {
        for (const n of await fs.promises.readdir(hostPath(cur))) if (!isTrashDirName(n)) stack.push(path.posix.join(cur, n));
      } catch {
        /* unreadable folder: skipped in the zip too */
      }
    } else if (st.isFile()) {
      files++;
      bytes += st.size;
    }
  }
  return { bytes, files, dirs, partial };
}

export async function prepareZip(user: User, paths: string[]): Promise<ZipEstimate> {
  if (!paths.length) throw badRequest("Choose something to download.");
  if (paths.length > 1000) throw badRequest("Select fewer than 1,000 items to download at once.");
  sweep();
  const scope = await scopeFor(user);
  const items: { real: string; name: string }[] = [];
  const names = new Set<string>();
  for (const p of paths) {
    const t = await authorize(user, p, "read", { scope });
    if (["/proc", "/sys", "/dev", "/run"].some((x) => isWithin(t.real, x))) throw badRequest("System folders like /proc can't be downloaded.");
    let name = path.posix.basename(t.path) || "Computer";
    for (let i = 2; names.has(name); i++) name = `${path.posix.basename(t.path)} (${i})`;
    names.add(name);
    items.push({ real: t.real, name });
  }
  // Nested selections would duplicate data.
  const filtered = items.filter((i) => !items.some((o) => o !== i && o.real !== i.real && isWithin(i.real, o.real)));
  const m = await measure(filtered);
  const zipName = filtered.length === 1 ? filtered[0]!.name : `${path.posix.basename(path.posix.dirname(paths[0]!)) || "files"} (${filtered.length} items)`;
  let warning: string | null = null;
  const more = m.partial ? " at least" : "";
  if (m.bytes > WARN_BYTES) warning = `This is${more} ${formatBytes(m.bytes)}. It will take a while and needs that much free space where you save it.`;
  else if (m.files > WARN_FILES) warning = `This is${more} ${plural(m.files, "file")}. Zipping them takes a while.`;
  else if (m.partial) warning = "This folder is very large; Gluon stopped counting early.";
  const token = newToken(18);
  pending().set(token, { userId: user.id, name: zipName, items: filtered, expires: Date.now() + TOKEN_MS, bytes: m.bytes, files: m.files });
  return { token, name: `${zipName}.zip`, bytes: m.bytes, files: m.files, dirs: m.dirs, partial: m.partial, warning };
}

/** Walk and add entries lazily so a 100k-file tree never holds 100k open files. */
async function addTree(archive: ZipArchive, real: string, name: string, signal: AbortSignal) {
  const stack: { real: string; rel: string }[] = [{ real, rel: name }];
  while (stack.length) {
    if (signal.aborted) return;
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(hostPath(cur.real));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      archive.append("", { name: `${cur.rel}/`, type: "directory", date: st.mtime, mode: st.mode & 0o7777 });
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(hostPath(cur.real));
      } catch {
        continue;
      }
      for (const n of names.sort().reverse()) if (!isTrashDirName(n)) stack.push({ real: path.posix.join(cur.real, n), rel: `${cur.rel}/${n}` });
    } else if (st.isFile()) {
      archive.file(hostPath(cur.real), { name: cur.rel, date: st.mtime, mode: st.mode & 0o7777, stats: st, store: isCompressed(cur.rel) } as Parameters<ZipArchive["file"]>[1]);
    } else if (st.isSymbolicLink()) {
      try {
        archive.symlink(cur.rel, await fs.promises.readlink(hostPath(cur.real)), st.mode & 0o7777);
      } catch {
        /* skip */
      }
    }
    // Let the archiver drain between batches (it queues entries internally).
    if (stack.length % 1000 === 0) await new Promise((r) => setImmediate(r));
  }
}

export async function streamZip(req: NextRequest, user: User, input: { token?: string; path?: string }): Promise<Response> {
  let job: Pending;
  if (input.token) {
    sweep();
    const p = pending().get(input.token);
    if (!p || p.userId !== user.id) throw notFound("That download link");
    job = p;
  } else if (input.path) {
    const t = await authorize(user, input.path, "read");
    if (!t.stat?.isDirectory()) throw badRequest("Only folders are zipped. Download the file directly.");
    const name = path.posix.basename(t.path) || "Computer";
    job = { userId: user.id, name, items: [{ real: t.real, name }], expires: 0, bytes: 0, files: 0 };
  } else {
    throw badRequest("Choose a folder to download.");
  }
  // Re-check access at download time (grants may have changed since the estimate).
  const scope = await scopeFor(user);
  for (const i of job.items) await authorize(user, i.real, "read", { scope });

  const big = job.bytes > 3.5 * 1024 ** 3 || job.files > 60_000;
  const archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: big, statConcurrency: 4 });
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => {
    abort.abort();
    archive.abort();
  });
  archive.on("warning", (e) => console.warn("[gluon] zip warning", e.message));
  archive.on("error", (e) => {
    console.error("[gluon] zip failed", e.message);
    archive.destroy(e);
  });
  void (async () => {
    try {
      for (const i of job.items) await addTree(archive, i.real, i.name, abort.signal);
      if (!abort.signal.aborted) await archive.finalize();
    } catch (e) {
      archive.destroy(e as Error);
    }
  })();
  const web = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
  return new Response(web, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": disposition("attachment", `${job.name}.zip`),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

