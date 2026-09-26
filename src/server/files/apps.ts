import "server-only";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type Docker from "dockerode";
import { DATA_DIR } from "../db";
import { AppError, badRequest, notFound } from "../errors";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import { host, localSpawn } from "../host/exec";
import { docker } from "../docker/client";
import { listApps, type AppSummary } from "../docker/apps";
import type { User } from "../auth/users";
import type { AppUse, FileJob, OwnershipPreview, RunsAs } from "@/lib/files-types";
import { listJoin, plural } from "@/lib/format";
import { assertMutable, authorize, protectedInside, resolveHost } from "./paths";
import { groupName, userName } from "./ids";
import { startJob } from "./jobs";

type Where = { ip: string; zone: string };

// ---------------------------------------------------------------- who runs as whom

function envMap(env: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of env ?? []) {
    const i = e.indexOf("=");
    if (i > 0) m.set(e.slice(0, i).toUpperCase(), e.slice(i + 1));
  }
  return m;
}

/** Look a user/group name up in the container's own /etc/passwd (via its root in /proc). */
function containerLookup(pid: number, file: "passwd" | "group", name: string): number | null {
  if (!pid) return null;
  try {
    for (const line of fs.readFileSync(`/proc/${pid}/root/etc/${file}`, "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === name && Number.isInteger(Number(f[2]))) return Number(f[2]);
    }
  } catch {
    /* not running or unreadable */
  }
  return null;
}

function named(uid: number, gid: number, source: string): RunsAs {
  return { uid, gid, user: userName(uid), group: groupName(gid), source, root: uid === 0 };
}

/**
 * The uid/gid an app's files should belong to: linuxserver-style PUID/PGID first, then the
 * container's `user:`, else root (the image default).
 */
export function runsAs(info: Docker.ContainerInspectInfo): RunsAs | null {
  const env = envMap(info.Config?.Env);
  const puid = env.get("PUID") ?? env.get("USER_UID") ?? env.get("UID") ?? env.get("USERMAP_UID");
  const pgid = env.get("PGID") ?? env.get("USER_GID") ?? env.get("GID") ?? env.get("USERMAP_GID");
  if (puid && /^\d+$/.test(puid)) {
    const gid = pgid && /^\d+$/.test(pgid) ? Number(pgid) : Number(puid);
    return named(Number(puid), gid, `PUID=${puid}${pgid ? ` PGID=${pgid}` : ""}`);
  }
  const u = (info.Config?.User ?? "").trim();
  if (!u) return named(0, 0, "root (the image default)");
  const [us, gs] = u.split(":");
  const pid = info.State?.Pid ?? 0;
  const uid = /^\d+$/.test(us!) ? Number(us) : containerLookup(pid, "passwd", us!);
  if (uid === null) return null;
  let gid: number | null = uid;
  if (gs) gid = /^\d+$/.test(gs) ? Number(gs) : containerLookup(pid, "group", gs);
  else {
    // user without group: primary group from the container's passwd.
    try {
      const line = fs
        .readFileSync(`/proc/${pid}/root/etc/passwd`, "utf8")
        .split("\n")
        .find((l) => l.split(":")[2] === String(uid));
      if (line) gid = Number(line.split(":")[3]);
    } catch {
      /* keep uid */
    }
  }
  if (gid === null || !Number.isInteger(gid)) return null;
  return named(uid, gid, `user: ${u}`);
}

// ---------------------------------------------------------------- used by apps

export async function usedBy(user: User, p: string): Promise<{ path: string; uses: AppUse[] }> {
  const t = await authorize(user, p, "read");
  const [containers, apps] = await Promise.all([docker().listContainers({ all: true }), listApps().catch(() => [] as AppSummary[])]);
  const appOf = new Map<string, AppSummary>();
  for (const a of apps) for (const c of a.containers) appOf.set(c.id, a);
  const resolved = new Map<string, string>();
  const real = async (src: string) => {
    if (!resolved.has(src)) {
      try {
        resolved.set(src, (await resolveHost(src)).real);
      } catch {
        resolved.set(src, src);
      }
    }
    return resolved.get(src)!;
  };
  const inspected = new Map<string, Docker.ContainerInspectInfo | null>();
  const inspect = async (id: string) => {
    if (!inspected.has(id)) inspected.set(id, await docker().getContainer(id).inspect().catch(() => null));
    return inspected.get(id)!;
  };

  const uses: AppUse[] = [];
  for (const c of containers) {
    for (const m of c.Mounts ?? []) {
      if (!m.Source?.startsWith("/")) continue;
      const src = await real(normalizeHostPath(m.Source));
      let relation: AppUse["relation"] | null = null;
      let containerPath: string | null = null;
      if (src === t.real) {
        relation = "this";
        containerPath = m.Destination;
      } else if (isWithin(t.real, src)) {
        relation = "within";
        containerPath = path.posix.join(m.Destination, t.real.slice(src === "/" ? 0 : src.length));
      } else if (isWithin(src, t.real)) {
        relation = "below";
      }
      if (!relation) continue;
      const app = appOf.get(c.Id);
      const info = await inspect(c.Id);
      uses.push({
        appId: app?.id ?? (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        appName: app?.name ?? (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        icon: app?.icon ?? null,
        container: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        containerState: c.State,
        source: src,
        destination: m.Destination,
        containerPath,
        rw: m.RW !== false,
        relation,
        runsAs: info ? runsAs(info) : null,
      });
    }
  }
  const rank = { this: 0, within: 1, below: 2 };
  uses.sort((a, b) => rank[a.relation] - rank[b.relation] || a.appName.localeCompare(b.appName));
  return { path: t.path, uses };
}

// ---------------------------------------------------------------- fix ownership

async function targetFor(user: User, real: string, app: string | undefined, uid: number | undefined, gid: number | undefined): Promise<{ target: RunsAs; app: { id: string; name: string } | null }> {
  if (uid !== undefined) {
    const g = gid ?? uid;
    return { target: named(uid, g, "chosen by hand"), app: null };
  }
  if (!app) throw badRequest("Choose an app (or a user) to give the files to.");
  const apps = await listApps();
  const a = apps.find((x) => x.id === app);
  if (!a) throw notFound("That app");
  const uses = (await usedBy(user, real)).uses.filter((u) => u.appId === a.id && u.runsAs);
  let runs = uses.find((u) => u.rw && u.runsAs && !u.runsAs.root)?.runsAs ?? uses.find((u) => u.runsAs)?.runsAs ?? null;
  if (!runs) {
    for (const c of a.containers) {
      const info = await docker().getContainer(c.id).inspect().catch(() => null);
      const r = info ? runsAs(info) : null;
      if (r && (!runs || (runs.root && !r.root))) runs = r;
    }
  }
  if (!runs) throw new AppError("unknown_user", `Couldn't work out which user ${a.name} runs as. Choose a user instead.`, 409);
  return { target: runs, app: { id: a.id, name: a.name } };
}

async function guardRecursive(real: string) {
  if (real === "/") throw new AppError("protected", "Gluon won't change the owner of every file on the computer.", 403);
  await assertMutable(real, "change owners in");
  const inside = await protectedInside(real);
  if (inside) throw new AppError("protected", `${real} contains ${inside}, which must keep its current owners. Pick a folder further down.`, 403);
  if (path.posix.dirname(real) === "/" && !["/DATA", "/srv", "/data", "/mnt", "/media", "/storage"].includes(real)) {
    throw new AppError("protected", `${real} is a top-level system folder; pick a folder inside it.`, 403);
  }
}

interface WalkStats {
  total: number;
  toChange: number;
  byOwner: Map<string, number>;
  samples: OwnershipPreview["samples"];
  partial: boolean;
}

/** One pass of find over the tree (one filesystem, no link following). */
function walkOwners(real: string, target: RunsAs, signal: AbortSignal, onProgress: (s: WalkStats) => void, onMismatch?: (uid: number, gid: number, rel: string) => void, timeoutMs = 180_000): Promise<WalkStats> {
  return new Promise((resolve, reject) => {
    const child = localSpawn("find", [hostPath(real), "-xdev", "-printf", "%U\\t%G\\t%y\\t%P\\0"]);
    const s: WalkStats = { total: 0, toChange: 0, byOwner: new Map(), samples: [], partial: false };
    const decoder = new StringDecoder("utf8");
    let buf = "";
    let last = 0;
    const timer = setTimeout(() => {
      s.partial = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort);
    child.stdout!.on("data", (b: Buffer) => {
      buf += decoder.write(b);
      let i: number;
      while ((i = buf.indexOf("\0")) >= 0) {
        const rec = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const [u, g, y, rel = ""] = rec.split("\t");
        const uid = Number(u);
        const gid = Number(g);
        s.total++;
        if (uid !== target.uid || gid !== target.gid) {
          s.toChange++;
          const key = `${uid}:${gid}`;
          s.byOwner.set(key, (s.byOwner.get(key) ?? 0) + 1);
          if (s.samples.length < 20) {
            s.samples.push({ path: rel ? path.posix.join(real, rel) : real, type: y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "symlink" : "other", user: userName(uid), group: groupName(gid) });
          }
          onMismatch?.(uid, gid, rel);
        }
      }
      if (Date.now() - last > 300) {
        last = Date.now();
        onProgress(s);
      }
    });
    child.stderr!.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new AppError("cancelled", "Stopped.", 499));
      resolve(s);
    });
  });
}

function describeTarget(t: RunsAs) {
  const u = t.user ?? String(t.uid);
  const g = t.group ?? String(t.gid);
  return u === g ? u : `${u}:${g}`;
}

/** Count what "fix ownership" would change. Streams progress through `emit` (ndjson). */
export async function previewOwnership(
  user: User,
  input: { path: string; app?: string; uid?: number; gid?: number },
  emit: (e: unknown) => void,
  signal: AbortSignal,
): Promise<OwnershipPreview> {
  const t = await authorize(user, input.path, "write");
  if (!t.stat?.isDirectory()) throw badRequest("Choose a folder.");
  await guardRecursive(t.real);
  const { target, app } = await targetFor(user, t.real, input.app, input.uid, input.gid);
  const base = { path: t.path, app, target };
  if (target.root && input.uid === undefined) {
    return { ...base, total: 0, toChange: 0, byOwner: [], samples: [], partial: false, summary: `${app?.name ?? "This app"} runs as root, so it can already read and write everything here. Nothing needs to change.` };
  }
  emit({ type: "progress", phase: "Checking files", done: 0, total: null });
  const s = await walkOwners(t.real, target, signal, (st) => emit({ type: "progress", phase: "Checking files", done: st.total, total: null, toChange: st.toChange }));
  const byOwner = [...s.byOwner.entries()]
    .map(([k, count]) => {
      const [u, g] = k.split(":").map(Number) as [number, number];
      return { uid: u, gid: g, user: userName(u), group: groupName(g), count };
    })
    .sort((a, b) => b.count - a.count);
  const who = app ? `${app.name} (${describeTarget(target)})` : describeTarget(target);
  const summary = s.toChange
    ? `${plural(s.toChange, "item")} of ${s.total.toLocaleString()}${s.partial ? "+" : ""} will be given to ${who}. They currently belong to ${listJoin(byOwner.slice(0, 3).map((o) => `${o.user ?? o.uid}${o.group && o.group !== o.user ? `:${o.group}` : ""}`))}${byOwner.length > 3 ? " and others" : ""}.`
    : `Everything here already belongs to ${who}. Nothing needs to change.`;
  return { ...base, total: s.total, toChange: s.toChange, byOwner, samples: s.samples, partial: s.partial, summary };
}

const MANIFEST_DIR = path.join(DATA_DIR, "ownership");

interface Manifest {
  root: string;
  uid: number;
  gid: number;
  at: number;
}

/** Stream a manifest (header, then uid\tgid\trel records, NUL-separated) without loading it whole. */
async function* readManifest(file: string): AsyncGenerator<{ header: Manifest } | { uid: number; gid: number; rel: string }> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let first = true;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
    buf += decoder.write(chunk as Buffer);
    let i: number;
    while ((i = buf.indexOf("\0")) >= 0) {
      const rec = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (first) {
        first = false;
        yield { header: JSON.parse(rec) as Manifest };
        continue;
      }
      const [u, g, rel = ""] = rec.split("\t");
      yield { uid: Number(u), gid: Number(g), rel };
    }
  }
}

/** chown in batches of 400 paths per call, one owner per call. Returns how many failed. */
async function chownStream(entries: AsyncIterable<{ owner: string; path: string }>, onBatch: (n: number) => void, check: () => void): Promise<number> {
  let failed = 0;
  let owner = "";
  let batch: string[] = [];
  const flush = async () => {
    if (!batch.length) return;
    check();
    const { stderr } = await host("chown", ["-h", "--", owner, ...batch], { timeoutMs: 120_000, okCodes: [1] });
    if (stderr) failed += stderr.trim().split("\n").filter(Boolean).length;
    onBatch(batch.length);
    batch = [];
  };
  for await (const e of entries) {
    if (e.owner !== owner || batch.length >= 400) {
      await flush();
      owner = e.owner;
    }
    batch.push(e.path);
  }
  await flush();
  return failed;
}

/** Give a folder tree to an app's user. Saves the previous owners so it can be undone. */
export async function applyOwnership(user: User, input: { path: string; app?: string; uid?: number; gid?: number }, where: Where): Promise<FileJob> {
  const t = await authorize(user, input.path, "write");
  if (!t.stat?.isDirectory()) throw badRequest("Choose a folder.");
  await guardRecursive(t.real);
  const { target, app } = await targetFor(user, t.real, input.app, input.uid, input.gid);
  if (target.root && input.uid === undefined) throw new AppError("nothing_to_do", `${app?.name ?? "That app"} runs as root; nothing needs to change.`, 409);
  const who = app ? `${app.name} (${describeTarget(target)})` : describeTarget(target);
  const title = `Give ${path.posix.basename(t.real)} to ${who}`;
  return startJob(
    user,
    "chown",
    title,
    { path: t.real, uid: target.uid, gid: target.gid, app: app?.id ?? null },
    where,
    async (ctx) => {
      fs.mkdirSync(MANIFEST_DIR, { recursive: true, mode: 0o700 });
      const manifest = path.join(MANIFEST_DIR, `${ctx.id}.tsv`);
      const out = fs.createWriteStream(manifest, { mode: 0o600 });
      const header: Manifest = { root: t.real, uid: target.uid, gid: target.gid, at: Date.now() };
      out.write(JSON.stringify(header) + "\0");
      ctx.progress({ phase: "Finding files to change" });
      const s = await walkOwners(
        t.real,
        target,
        ctx.signal,
        (st) => ctx.progress({ phase: "Finding files to change", done: 0, total: st.toChange }),
        (uid, gid, rel) => {
          out.write(`${uid}\t${gid}\t${rel}\0`);
        },
        30 * 60_000,
      );
      await new Promise<void>((r) => out.end(r));
      if (s.partial) {
        fs.rmSync(manifest, { force: true });
        throw new AppError("timeout", "Listing the files took too long, so nothing was changed.", 504);
      }
      if (!s.toChange) {
        fs.rmSync(manifest, { force: true });
        return { message: `Everything in ${t.real} already belonged to ${who}.`, result: { changed: 0 } };
      }
      ctx.progress({ phase: "Changing owners", done: 0, total: s.toChange });
      const owner = `${target.uid}:${target.gid}`;
      let done = 0;
      const failed = await chownStream(
        (async function* () {
          for await (const r of readManifest(manifest)) if (!("header" in r)) yield { owner, path: r.rel ? path.posix.join(t.real, r.rel) : t.real };
        })(),
        (n) => {
          done += n;
          ctx.progress({ done });
        },
        () => ctx.check(),
      );
      return {
        message: `Gave ${plural(done - failed, "item")} in ${t.real} to ${who}${failed ? `; ${plural(failed, "item")} couldn't be changed` : ""}.`,
        result: { changed: done - failed, failed, undo: ctx.id, path: t.real, uid: target.uid, gid: target.gid },
      };
    },
    { action: "files.chown", target: t.real },
  );
}

/** Put back the owners recorded by an earlier ownership job. */
export async function undoOwnership(user: User, jobId: string, where: Where): Promise<FileJob> {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(jobId)) throw notFound("That change");
  const manifest = path.join(MANIFEST_DIR, `${jobId}.tsv`);
  if (!fs.existsSync(manifest)) throw notFound("The record of that change");
  let header: Manifest | null = null;
  for await (const r of readManifest(manifest)) {
    if ("header" in r) header = r.header;
    break;
  }
  if (!header?.root) throw new AppError("bad_manifest", "The record of that change is damaged.", 500);
  const root = normalizeHostPath(header.root);
  await assertMutable(root, "change owners in");
  return startJob(
    user,
    "chown-undo",
    `Put back the previous owners in ${path.posix.basename(root)}`,
    { manifest: jobId, path: root },
    where,
    async (ctx) => {
      ctx.progress({ phase: "Restoring owners", done: 0 });
      let done = 0;
      const failed = await chownStream(
        (async function* () {
          for await (const r of readManifest(manifest)) if (!("header" in r)) yield { owner: `${r.uid}:${r.gid}`, path: r.rel ? path.posix.join(root, r.rel) : root };
        })(),
        (n) => {
          done += n;
          ctx.progress({ done });
        },
        () => ctx.check(),
      );
      fs.renameSync(manifest, `${manifest}.undone`);
      return { message: `Put back the previous owners of ${plural(done - failed, "item")} in ${root}${failed ? `; ${plural(failed, "item")} couldn't be changed (probably removed since)` : ""}.`, result: { restored: done - failed, failed } };
    },
    { action: "files.chown_undo", target: root },
  );
}
