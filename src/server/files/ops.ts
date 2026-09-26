import "server-only";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { run } from "../db";
import { AppError, badRequest, conflict } from "../errors";
import { audit } from "../audit";
import { hostPath, isWithin } from "../host/paths";
import type { User } from "../auth/users";
import type { ConflictPolicy, FileEntry, FileJob } from "@/lib/files-types";
import { formatBytes, plural } from "@/lib/format";
import { assertMutable, assertRemovable, authorize, cleanName, freeName, logicalChild, scopeFor, type Target } from "./paths";
import { freeBytes, mountOf } from "./mounts";
import { Cancelled, startJob, type JobContext } from "./jobs";
import { moveToTrash } from "./trash";
import { cachedSizes, pinMap, toEntry } from "./list";

type Where = { ip: string; zone: string };

async function lexists(real: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(hostPath(real));
  } catch {
    return null;
  }
}

async function entryOf(user: User, t: Pick<Target, "scope">, logical: string, real: string): Promise<FileEntry> {
  const st = await fs.promises.lstat(hostPath(real));
  return toEntry({ scope: t.scope, pins: pinMap(user.id), sizes: cachedSizes([real]) }, logical, real, st);
}

/** Keep folder pins and recents pointing at the right place after a rename/move. */
function repointPins(fromPaths: string[], to: string) {
  for (const from of new Set(fromPaths)) {
    if (!from || from === "/") continue;
    const like = `${from.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
    try {
      run("UPDATE pins SET target = ? || substr(target, ?) WHERE kind = 'folder' AND (target = ? OR target LIKE ? ESCAPE '\\')", to, from.length + 1, from, like);
      run("UPDATE OR IGNORE file_recents SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ? ESCAPE '\\'", to, from.length + 1, from, like);
    } catch {
      /* recents table missing */
    }
  }
}

// ---------------------------------------------------------------- new folder / rename

export async function makeFolder(user: User, parent: string, rawName: string, where: Where): Promise<FileEntry> {
  const name = cleanName(rawName, "folder name");
  const dir = await authorize(user, parent, "write");
  if (!dir.stat?.isDirectory()) throw new AppError("not_a_folder", "Choose a folder to create it in.", 400);
  await assertMutable(dir.real, "create folders in");
  const real = path.posix.join(dir.real, name);
  try {
    await fs.promises.mkdir(hostPath(real), { mode: 0o755 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw conflict(`There's already something called ${name} here.`);
    if (code === "EROFS") throw new AppError("read_only", "That drive is mounted read-only.", 409);
    throw e;
  }
  // New folders belong to whoever owns the folder they're in (e.g. the media user), not root.
  await fs.promises.lchown(hostPath(real), dir.stat.uid, dir.stat.gid).catch(() => {});
  audit(user, { action: "files.mkdir", summary: `Created folder ${name}`, target: real }, where);
  return entryOf(user, dir, logicalChild(dir, name), real);
}

export async function renamePath(user: User, p: string, rawName: string, where: Where): Promise<FileEntry> {
  const name = cleanName(rawName);
  const t = await authorize(user, p, "write", { followLast: false });
  await assertRemovable(t, "rename");
  const oldName = path.posix.basename(t.real);
  if (name === oldName) return entryOf(user, t, t.path, t.real);
  const parent = path.posix.dirname(t.real);
  const dest = path.posix.join(parent, name);
  const existing = await lexists(dest);
  // Allow case-only renames on case-insensitive filesystems (same inode).
  if (existing && !(existing.ino === t.stat!.ino && existing.dev === t.stat!.dev)) {
    throw conflict(`There's already something called ${name} in this folder.`);
  }
  await fs.promises.rename(t.fsPath, hostPath(dest));
  const logical = path.posix.join(path.posix.dirname(t.path), name);
  repointPins([t.path, t.real], logical);
  audit(user, { action: "files.rename", summary: `Renamed ${oldName} to ${name}`, target: dest, detail: { from: t.real, to: dest } }, where);
  return entryOf(user, t, logical, dest);
}

// ---------------------------------------------------------------- conflicts

export async function findConflicts(user: User, sources: string[], dest: string): Promise<{ conflicts: { name: string; source: string; existing: FileEntry }[] }> {
  const scope = await scopeFor(user);
  const d = await authorize(user, dest, "read", { scope });
  const out: { name: string; source: string; existing: FileEntry }[] = [];
  for (const s of sources) {
    const src = await authorize(user, s, "read", { scope, followLast: false });
    const name = path.posix.basename(src.real);
    const target = path.posix.join(d.real, name);
    if (target === src.real) continue;
    if (await lexists(target)) out.push({ name, source: src.path, existing: await entryOf(user, d, logicalChild(d, name), target) });
  }
  return { conflicts: out };
}

// ---------------------------------------------------------------- copy engine

interface Totals {
  files: number;
  dirs: number;
  links: number;
  special: number;
  bytes: number;
}

async function scan(real: string, ctx: JobContext, totals: Totals): Promise<void> {
  const stack = [real];
  let n = 0;
  while (stack.length) {
    ctx.check();
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(hostPath(cur));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      totals.dirs++;
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(hostPath(cur));
      } catch {
        /* unreadable: counted when copying */
      }
      for (const nm of names) stack.push(path.posix.join(cur, nm));
    } else if (st.isFile()) {
      totals.files++;
      totals.bytes += st.size;
    } else if (st.isSymbolicLink()) totals.links++;
    else totals.special++;
    if (++n % 500 === 0) ctx.progress({ phase: "Counting files", total: totals.files, bytesTotal: totals.bytes });
  }
}

interface CopyState {
  filesDone: number;
  bytesDone: number;
  skippedSpecial: string[];
  errors: string[];
}

class Meter extends Transform {
  constructor(private onBytes: (n: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}

async function copyFile(src: string, dest: string, st: fs.Stats, ctx: JobContext, state: CopyState, report: () => void) {
  const from = hostPath(src);
  const to = hostPath(dest);
  if (st.size < 32 * 1024 * 1024) {
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    state.bytesDone += st.size;
  } else {
    const out = fs.createWriteStream(to, { flags: "wx", mode: st.mode & 0o7777 });
    await pipeline(
      fs.createReadStream(from, { highWaterMark: 1024 * 1024 }),
      new Meter((n) => {
        state.bytesDone += n;
        report();
      }),
      out,
      { signal: ctx.signal },
    );
    const fh = await fs.promises.open(to, "r+");
    await fh.sync().finally(() => fh.close());
  }
  await fs.promises.chmod(to, st.mode & 0o7777).catch(() => {});
  await fs.promises.lchown(to, st.uid, st.gid).catch(() => {});
  await fs.promises.utimes(to, st.atime, st.mtime).catch(() => {});
  state.filesDone++;
  report();
}

/** Copy `src` (file, link or folder) to the new path `dest`, preserving modes, owners and times. */
async function copyTree(src: string, dest: string, ctx: JobContext, state: CopyState, logicalRoot: string) {
  let lastReport = 0;
  const report = () => {
    const t = Date.now();
    if (t - lastReport < 200) return;
    lastReport = t;
    ctx.progress({ done: state.filesDone, bytesDone: state.bytesDone });
  };
  const dirsToFinish: { dest: string; st: fs.Stats }[] = [];
  const stack: { src: string; dest: string }[] = [{ src, dest }];
  while (stack.length) {
    ctx.check();
    const item = stack.pop()!;
    const st = await fs.promises.lstat(hostPath(item.src));
    ctx.progress({ current: logicalRoot + item.src.slice(src.length) });
    if (st.isDirectory()) {
      await fs.promises.mkdir(hostPath(item.dest), { mode: 0o700 });
      dirsToFinish.push({ dest: item.dest, st });
      const names = await fs.promises.readdir(hostPath(item.src));
      for (const n of names.reverse()) stack.push({ src: path.posix.join(item.src, n), dest: path.posix.join(item.dest, n) });
    } else if (st.isFile()) {
      await copyFile(item.src, item.dest, st, ctx, state, report);
    } else if (st.isSymbolicLink()) {
      const target = await fs.promises.readlink(hostPath(item.src));
      await fs.promises.symlink(target, hostPath(item.dest));
      await fs.promises.lchown(hostPath(item.dest), st.uid, st.gid).catch(() => {});
      await fs.promises.lutimes(hostPath(item.dest), st.atime, st.mtime).catch(() => {});
    } else {
      state.skippedSpecial.push(item.src);
    }
  }
  // Folders last, deepest first, so their times aren't bumped by the files written into them.
  for (const d of dirsToFinish.reverse()) {
    const p = hostPath(d.dest);
    await fs.promises.chmod(p, d.st.mode & 0o7777).catch(() => {});
    await fs.promises.lchown(p, d.st.uid, d.st.gid).catch(() => {});
    await fs.promises.utimes(p, d.st.atime, d.st.mtime).catch(() => {});
  }
  ctx.progress({ done: state.filesDone, bytesDone: state.bytesDone });
}

// ---------------------------------------------------------------- copy / move

interface Plan {
  src: Target;
  name: string;
  finalName: string | null; // null = skip
  replace: boolean;
  sameFs: boolean;
}

async function plan(user: User, sources: string[], dest: string, policy: ConflictPolicy, mode: "copy" | "move") {
  if (!sources.length) throw badRequest("Choose something first.");
  if (sources.length > 1000) throw badRequest("That's too many items at once. Select fewer than 1,000.");
  const scope = await scopeFor(user);
  const d = await authorize(user, dest, "write", { scope });
  if (!d.stat?.isDirectory()) throw new AppError("not_a_folder", "Choose a folder to put them in.", 400);
  await assertMutable(d.real, mode === "copy" ? "copy things into" : "move things into");
  const destMount = mountOf(d.real)?.mount ?? null;
  const plans: Plan[] = [];
  const names = new Set<string>();
  for (const s of sources) {
    const src = await authorize(user, s, mode === "move" ? "write" : "read", { scope, followLast: false });
    if (mode === "move") await assertRemovable(src, "move");
    const name = path.posix.basename(src.real);
    if (names.has(name)) throw badRequest(`Two of the selected items are called ${name}. Rename one first.`);
    names.add(name);
    if (isWithin(d.real, src.real)) throw badRequest(`You can't ${mode} ${name} into itself.`);
    const target = path.posix.join(d.real, name);
    const exists = await lexists(target);
    let finalName: string | null = name;
    let replace = false;
    if (mode === "move" && path.posix.dirname(src.real) === d.real) {
      finalName = null; // already there
    } else if (exists) {
      if (policy === "skip") finalName = null;
      else if (policy === "rename") finalName = await freeName(d.real, name);
      else {
        if (target === src.real) throw badRequest(`${name} can't replace itself.`);
        await assertRemovable({ real: target, root: d.root, scope }, "replace");
        replace = true;
      }
    }
    plans.push({ src, name, finalName, replace, sameFs: mode === "move" && destMount !== null && mountOf(src.real)?.mount === destMount });
  }
  return { d, plans, scope };
}

export interface TransferResult {
  job: FileJob | null;
  moved?: { from: string; to: string }[];
  skipped: string[];
}

/** Move items. Same-drive moves are instant renames; across drives it becomes a copy-then-delete job. */
export async function moveItems(user: User, sources: string[], dest: string, policy: ConflictPolicy, where: Where): Promise<TransferResult> {
  const { d, plans } = await plan(user, sources, dest, policy, "move");
  const skipped = plans.filter((p) => p.finalName === null).map((p) => p.src.path);
  const todo = plans.filter((p) => p.finalName !== null);
  if (!todo.length) return { job: null, moved: [], skipped };

  if (todo.every((p) => p.sameFs)) {
    const moved: { from: string; to: string }[] = [];
    for (const p of todo) {
      const to = path.posix.join(d.real, p.finalName!);
      if (p.replace) await moveToTrash(to, user.id);
      await fs.promises.rename(p.src.fsPath, hostPath(to));
      repointPins([p.src.path, p.src.real], logicalChild(d, p.finalName!));
      moved.push({ from: p.src.real, to });
    }
    audit(user, { action: "files.move", summary: moved.length === 1 ? `Moved ${path.posix.basename(moved[0]!.from)} to ${d.real}` : `Moved ${plural(moved.length, "item")} to ${d.real}`, target: d.real, detail: { moved, skipped, replacedToTrash: todo.filter((p) => p.replace).length } }, where);
    return { job: null, moved, skipped };
  }

  const title = todo.length === 1 ? `Move ${todo[0]!.name} to ${path.posix.basename(d.real) || "/"}` : `Move ${plural(todo.length, "item")} to ${path.posix.basename(d.real) || "/"}`;
  const job = startJob(user, "move", title, { sources: todo.map((p) => p.src.real), dest: d.real, policy }, where, (ctx) => transfer(user, ctx, d, todo, "move"), { action: "files.move", target: d.real });
  return { job, skipped };
}

export async function copyItems(user: User, sources: string[], dest: string, policy: ConflictPolicy, where: Where): Promise<TransferResult> {
  const { d, plans } = await plan(user, sources, dest, policy, "copy");
  const skipped = plans.filter((p) => p.finalName === null).map((p) => p.src.path);
  const todo = plans.filter((p) => p.finalName !== null);
  if (!todo.length) return { job: null, skipped };
  const title = todo.length === 1 ? `Copy ${todo[0]!.name} to ${path.posix.basename(d.real) || "/"}` : `Copy ${plural(todo.length, "item")} to ${path.posix.basename(d.real) || "/"}`;
  const job = startJob(user, "copy", title, { sources: todo.map((p) => p.src.real), dest: d.real, policy }, where, (ctx) => transfer(user, ctx, d, todo, "copy"), { action: "files.copy", target: d.real });
  return { job, skipped };
}

async function transfer(user: User, ctx: JobContext, d: Target, todo: Plan[], mode: "copy" | "move") {
  // Instant renames first (move within a drive).
  const done: { from: string; to: string }[] = [];
  const failed: { path: string; error: string }[] = [];
  const heavy: Plan[] = [];
  for (const p of todo) {
    if (mode === "move" && p.sameFs) {
      const to = path.posix.join(d.real, p.finalName!);
      if (p.replace) await moveToTrash(to, user.id);
      await fs.promises.rename(p.src.fsPath, hostPath(to));
      repointPins([p.src.path, p.src.real], logicalChild(d, p.finalName!));
      done.push({ from: p.src.real, to });
    } else heavy.push(p);
  }

  const totals: Totals = { files: 0, dirs: 0, links: 0, special: 0, bytes: 0 };
  ctx.progress({ phase: "Counting files" });
  for (const p of heavy) await scan(p.src.real, ctx, totals);
  ctx.progress({ total: totals.files, bytesTotal: totals.bytes });

  const free = freeBytes(d.real);
  if (free !== null && totals.bytes > free) {
    throw new AppError("no_space", `There isn't enough space: this needs ${formatBytes(totals.bytes)} but ${path.posix.basename(mountOf(d.real)?.mount ?? d.real) || "the drive"} has ${formatBytes(free)} free.`, 507);
  }

  const state: CopyState = { filesDone: 0, bytesDone: 0, skippedSpecial: [], errors: [] };
  ctx.progress({ phase: mode === "move" ? "Moving" : "Copying" });
  for (const [i, p] of heavy.entries()) {
    ctx.check();
    const final = path.posix.join(d.real, p.finalName!);
    const temp = path.posix.join(d.real, `.gluon-part-${ctx.id}-${i}`);
    try {
      await copyTree(p.src.real, temp, ctx, state, p.src.path);
      if (p.replace) await moveToTrash(final, user.id);
      else if (await lexists(final)) {
        // Someone created it meanwhile: never clobber.
        const alt = await freeName(d.real, p.finalName!);
        await fs.promises.rename(hostPath(temp), hostPath(path.posix.join(d.real, alt)));
        done.push({ from: p.src.real, to: path.posix.join(d.real, alt) });
        if (mode === "move") await removeSource(p, ctx);
        continue;
      }
      await fs.promises.rename(hostPath(temp), hostPath(final));
      done.push({ from: p.src.real, to: final });
      if (mode === "move") {
        await removeSource(p, ctx);
        repointPins([p.src.path, p.src.real], logicalChild(d, p.finalName!));
      }
    } catch (e) {
      await fs.promises.rm(hostPath(temp), { recursive: true, force: true }).catch(() => {});
      if (e instanceof Cancelled || ctx.signal.aborted) {
        throw new Cancelled(done.length ? `Stopped after ${plural(done.length, "item")}. What was already ${mode === "move" ? "moved" : "copied"} stays; the unfinished item was cleaned up.` : "Stopped. Nothing was changed.");
      }
      const msg = e instanceof AppError ? e.message : (e as NodeJS.ErrnoException).code === "ENOSPC" ? "The drive ran out of space." : (e as Error).message.replace(/\/proc\/1\/root/g, "");
      failed.push({ path: p.src.path, error: msg });
      if ((e as NodeJS.ErrnoException).code === "ENOSPC") break;
    }
  }

  const verb = mode === "move" ? "Moved" : "Copied";
  const parts = [`${verb} ${plural(done.length, "item")}`];
  if (totals.bytes) parts[0] += ` (${formatBytes(state.bytesDone)})`;
  if (state.skippedSpecial.length) parts.push(`skipped ${plural(state.skippedSpecial.length, "special file")}`);
  if (failed.length) parts.push(`${failed.length} failed: ${failed[0]!.error}`);
  return {
    message: parts.join("; "),
    result: { done, failed, skippedSpecial: state.skippedSpecial.slice(0, 50), files: state.filesDone, bytes: state.bytesDone },
    failed: failed.length > 0 && done.length === 0,
  };
}

async function removeSource(p: Plan, ctx: JobContext) {
  ctx.progress({ phase: "Removing originals", current: p.src.path });
  await fs.promises.rm(p.src.fsPath, { recursive: true, force: false, maxRetries: 2 });
  ctx.progress({ phase: "Moving" });
}
