import "server-only";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AppError, badRequest } from "../errors";
import { hostPath } from "../host/paths";
import { local } from "../host/exec";
import type { User } from "../auth/users";
import type { FileJob } from "@/lib/files-types";
import { formatBytes, plural } from "@/lib/format";
import { assertMutable, authorize, canSee, freeName, resolveHost, splitName, type Scope } from "./paths";
import { inDir, openDir, openFileIn } from "./safe";
import { freeBytes } from "./mounts";
import { Cancelled, startJob, type JobContext } from "./jobs";

type Where = { ip: string; zone: string };

type Format =
  | { kind: "zip" }
  | { kind: "tar"; flag: string | null }
  | { kind: "7z" }
  | { kind: "rar" }
  | { kind: "single"; tool: "gzip" | "xz" | "bzip2" | "zstd"; outName: string };

function formatOf(name: string): Format | null {
  const n = name.toLowerCase();
  if (n.endsWith(".zip")) return { kind: "zip" };
  if (n.endsWith(".tar")) return { kind: "tar", flag: null };
  if (/\.(tar\.gz|tgz)$/.test(n)) return { kind: "tar", flag: "--gzip" };
  if (/\.(tar\.bz2|tbz2?|tb2)$/.test(n)) return { kind: "tar", flag: "--bzip2" };
  if (/\.(tar\.xz|txz)$/.test(n)) return { kind: "tar", flag: "--xz" };
  if (/\.(tar\.zst|tzst|tar\.zstd)$/.test(n)) return { kind: "tar", flag: "--zstd" };
  if (n.endsWith(".7z")) return { kind: "7z" };
  if (n.endsWith(".rar")) return { kind: "rar" };
  const single: [RegExp, "gzip" | "xz" | "bzip2" | "zstd"][] = [
    [/\.gz$/, "gzip"],
    [/\.xz$/, "xz"],
    [/\.bz2$/, "bzip2"],
    [/\.zst$/, "zstd"],
  ];
  for (const [re, tool] of single) if (re.test(n)) return { kind: "single", tool, outName: name.replace(/\.[^.]+$/, "") };
  return null;
}

/** A tool from the container image, or failing that from the host. */
function findTool(names: string[]): { cmd: string; where: "local" | "host" } | null {
  for (const n of names) for (const dir of ["/usr/bin", "/usr/local/bin", "/bin"]) if (fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, n))) return { cmd: path.join(/*turbopackIgnore: true*/ dir, n), where: "local" };
  for (const n of names) for (const dir of ["/usr/bin", "/usr/local/bin", "/bin"]) if (fs.existsSync(hostPath(path.posix.join(dir, n)))) return { cmd: path.posix.join(dir, n), where: "host" };
  return null;
}

const ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

/** `into` is an open folder handed to the tool as its descriptor 3, so it extracts there and nowhere else. */
function run(cmd: string, args: string[], where: "local" | "host", stdin: "pipe" | "ignore" = "ignore", into: number | null = null): ChildProcess {
  const full = where === "host" ? ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", cmd, ...args] : [cmd, ...args];
  return spawn(full[0]!, full.slice(1), { env: ENV as unknown as NodeJS.ProcessEnv, stdio: into === null ? [stdin, "pipe", "pipe"] : [stdin, "pipe", "pipe", into] });
}

/**
 * Stop an extraction that is about to fill the drive (an archive can inflate far beyond its own
 * size, and extraction runs as root, which may use the space reserved for the system).
 */
interface SpaceWatch {
  path: string;
  /** Stop when free space falls below this many bytes. */
  reserve: number;
}

function wait(child: ChildProcess, ctx: JobContext, onLine?: (l: string) => void, space?: SpaceWatch): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = "";
    let buf = "";
    let full = false;
    const onAbort = () => child.kill("SIGKILL");
    ctx.signal.addEventListener("abort", onAbort);
    const watch = space
      ? setInterval(() => {
          const free = freeBytes(space.path);
          if (free !== null && free < space.reserve) {
            full = true;
            child.kill("SIGKILL");
          }
        }, 1000)
      : undefined;
    child.on("exit", () => clearInterval(watch));
    child.stdout?.on("data", (b: Buffer) => {
      if (!onLine) return;
      buf += b.toString();
      let i: number;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (err.length < 8000) err += b.toString();
    });
    child.on("error", (e) => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      clearInterval(watch);
      if (full) return reject(new AppError("no_space", "Stopped: extracting this archive would have filled the drive. The partly extracted files were removed.", 507));
      if (ctx.signal.aborted) return reject(new Cancelled("Stopped. The partly extracted files were removed."));
      if (code === 0 || (code === 1 && /warning/i.test(err))) return resolve();
      const last = err.trim().split("\n").filter(Boolean).slice(-2).join(" ").replace(/\/proc\/1\/root/g, "");
      reject(new AppError("extract_failed", /No space left/i.test(err) ? "The drive ran out of space while extracting." : /password|encrypted/i.test(err) ? "That archive is password-protected, which Gluon can't open." : `The archive couldn't be extracted${last ? `: ${last}` : "."}`, 500));
    });
  });
}

async function zipTotals(file: string): Promise<{ files: number; bytes: number } | null> {
  try {
    const { stdout } = await local("unzip", ["-l", file], { timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024 });
    const last = stdout.trim().split("\n").pop() ?? "";
    const m = last.match(/^\s*(\d+)\s+(\d+)\s+files?/);
    return m ? { bytes: Number(m[1]), files: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/**
 * Give everything extracted to the owner of the folder it lands in, and (for household members)
 * drop links that would point outside the folders shared with them once the result is in place.
 * Each folder is opened without following links, so nothing outside the extraction is touched.
 */
export async function settle(temp: string, rootRel: string, finalReal: string, uid: number, gid: number, scope: Scope, ctx: JobContext): Promise<number> {
  const stack = [temp];
  let n = 0;
  let dropped = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    await inDir(cur, null, async (dir) => {
      await dir.chown(uid, gid).catch(() => {});
      for (const name of await fs.promises.readdir(dir.here).catch(() => [] as string[])) {
        const st = await fs.promises.lstat(dir.at(name)).catch(() => null);
        if (!st) continue;
        if (st.isSymbolicLink() && !scope.admin) {
          const rel = path.posix.relative(path.posix.join(temp, rootRel), cur);
          const finalDir = rel.startsWith("..") ? finalReal : path.posix.join(finalReal, rel);
          const target = await fs.promises.readlink(dir.at(name));
          const points = target.startsWith("/") ? target : path.posix.join(finalDir, target);
          const r = await resolveHost(points).catch(() => null);
          if (!r || !canSee(scope, r.real)) {
            await fs.promises.unlink(dir.at(name)).catch(() => {});
            dropped++;
            continue;
          }
        }
        await fs.promises.lchown(dir.at(name), uid, gid).catch(() => {});
        if (st.isDirectory()) stack.push(path.posix.join(cur, name));
        if (++n % 2000 === 0) {
          ctx.check();
          ctx.progress({ phase: "Setting owners", current: cur });
        }
      }
    });
  }
  return dropped;
}

/**
 * Extract an archive next to itself: "Album.zip" → "Album/". If the archive holds a single top
 * folder, that folder becomes the result (no "Album/Album"). Extraction happens in a hidden temp
 * folder that is renamed into place at the end, so a failure never leaves half an extraction.
 */
export async function extractArchive(user: User, p: string, where: Where): Promise<FileJob> {
  const t = await authorize(user, p, "read");
  if (!t.stat?.isFile()) throw badRequest("Choose an archive file.");
  const name = path.posix.basename(t.real);
  const fmt = formatOf(name);
  if (!fmt) throw badRequest(`Gluon doesn't know how to extract ${name}. It handles zip, tar (gz, bz2, xz, zst), 7z and rar archives.`);
  const parent = await authorize(user, path.posix.dirname(t.path), "write");
  await assertMutable(parent.real, "extract into");
  let tool: { cmd: string; where: "local" | "host" } | null = null;
  // bsdtar (libarchive) first for zip/7z/rar: it refuses entries with ".." or absolute paths and
  // never writes through a symlink an archive created, which matters because extraction runs as root.
  const secure = fmt.kind === "zip" || fmt.kind === "7z" || fmt.kind === "rar" ? findTool(["bsdtar"]) : null;
  if (fmt.kind === "zip") tool = secure ?? findTool(["unzip"]);
  if (fmt.kind === "tar") tool = findTool(["tar"]);
  if (fmt.kind === "7z") tool = secure ?? findTool(["7zz", "7z", "7za"]);
  if (fmt.kind === "rar") tool = secure ?? findTool(["unrar", "7zz", "7z"]);
  if (fmt.kind === "single") tool = findTool([fmt.tool]);
  if (!tool) {
    const what = fmt.kind === "7z" ? "7-Zip" : fmt.kind === "rar" ? "unrar or 7-Zip" : fmt.kind === "single" ? fmt.tool : fmt.kind;
    throw new AppError("tool_missing", `${what} isn't installed on the server, so ${name} can't be extracted here.`, 501);
  }

  const size = t.stat.size;
  const zt = fmt.kind === "zip" ? await zipTotals(t.fsPath) : null;
  const free = freeBytes(parent.real);
  const needed = zt?.bytes ?? size;
  if (free !== null && needed > free) {
    throw new AppError("no_space", `Extracting ${name} needs about ${formatBytes(needed)} but the drive has ${formatBytes(free)} free.`, 507);
  }

  const toolUse = tool;
  const viaBsdtar = toolUse.cmd.endsWith("bsdtar");
  const space: SpaceWatch = { path: parent.real, reserve: Math.min(1024 ** 3, Math.max(64 * 1024 ** 2, (free ?? 0) * 0.05)) };
  return startJob(
    user,
    "extract",
    `Extract ${name}`,
    { path: t.real },
    where,
    async (ctx) => {
      const tempName = `.gluon-extract-${ctx.id}`;
      const temp = path.posix.join(parent.real, tempName);
      const archiveFs = toolUse.where === "host" ? t.real : t.fsPath;
      await inDir(parent.real, parent.stat, (d) => fs.promises.mkdir(d.at(tempName), { mode: 0o755 }));
      // The tool gets the temp folder as an open descriptor where it can, so a folder on the way
      // swapped for a link can't make it extract (as root) somewhere else.
      const into = await openDir(temp);
      const tempFs = into.fd !== null ? "/proc/self/fd/3" : toolUse.where === "host" ? temp : hostPath(temp);
      try {
        ctx.progress({ phase: "Extracting", total: zt?.files ?? null, bytesTotal: fmt.kind === "tar" || fmt.kind === "single" ? size : (zt?.bytes ?? null) });
        let files = 0;
        if (viaBsdtar) {
          const child = run(toolUse.cmd, ["-x", "--no-same-owner", "-f", archiveFs, "-C", tempFs], toolUse.where, "ignore", into.fd);
          await wait(child, ctx, undefined, space);
        } else if (fmt.kind === "zip") {
          const child = run(toolUse.cmd, ["-o", "-d", tempFs, archiveFs], toolUse.where, "ignore", into.fd);
          await wait(child, ctx, (l) => {
            const m = l.match(/^\s*(inflating|extracting|linking):\s+(.*?)\s*$/);
            if (m) {
              files++;
              ctx.progress({ done: files, current: m[2]!.replace(tempFs + "/", "") });
            }
          }, space);
        } else if (fmt.kind === "tar" || fmt.kind === "single") {
          // Feed the archive through stdin so progress = bytes read of the archive.
          const args =
            fmt.kind === "tar"
              ? ["-x", "-f", "-", "-C", tempFs, "--no-same-owner", "--delay-directory-restore", ...(fmt.flag ? [fmt.flag] : [])]
              : ["-d", "-c"];
          const child = run(toolUse.cmd, args, toolUse.where, "pipe", fmt.kind === "tar" ? into.fd : null);
          const input = fs.createReadStream(t.fsPath, { highWaterMark: 1024 * 1024 });
          let read = 0;
          input.on("data", (b) => {
            read += b.length;
            ctx.progress({ bytesDone: read });
          });
          input.on("error", () => child.kill("SIGKILL"));
          input.pipe(child.stdin!);
          child.stdin!.on("error", () => {});
          if (fmt.kind === "single") {
            const fh = await openFileIn(into, fmt.outName, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
            const out = fh.createWriteStream();
            child.stdout!.pipe(out);
            await Promise.all([wait(child, ctx, undefined, space), new Promise<void>((res, rej) => out.on("finish", res).on("error", rej))]);
          } else {
            await wait(child, ctx, undefined, space);
          }
        } else {
          const args = toolUse.cmd.endsWith("unrar") ? ["x", "-o+", "-idq", archiveFs, `${tempFs}/`] : ["x", "-y", "-bsp1", "-bso0", `-o${tempFs}`, archiveFs];
          const child = run(toolUse.cmd, args, toolUse.where, "ignore", into.fd);
          await wait(child, ctx, (l) => {
            const m = l.match(/(\d+)%/);
            if (m) ctx.progress({ bytesDone: Math.round((Number(m[1]) / 100) * size), bytesTotal: size });
          }, space);
        }
        ctx.check();

        // One top-level folder (or the single decompressed file)? Use it directly: no "Album/Album".
        const top = await fs.promises.readdir(into.here);
        const hoist = top.length === 1 && ((await fs.promises.lstat(into.at(top[0]!))).isDirectory() || fmt.kind === "single");
        const finalName = await freeName(parent.real, hoist ? top[0]! : splitName(name).stem);
        const dropped = await settle(temp, hoist ? top[0]! : "", path.posix.join(parent.real, finalName), parent.stat!.uid, parent.stat!.gid, parent.scope, ctx);
        await into.chmod(0o755).catch(() => {});
        await inDir(parent.real, parent.stat, async (d) => {
          if (hoist) {
            await fs.promises.rename(into.at(top[0]!), d.at(finalName));
            await fs.promises.rmdir(d.at(tempName));
          } else await fs.promises.rename(d.at(tempName), d.at(finalName));
        });
        const finalPath = path.posix.join(parent.path, finalName);
        return {
          message: `Extracted ${name} into ${finalName}${files ? ` (${plural(files, "file")})` : ""}${dropped ? `. Left out ${plural(dropped, "link")} pointing outside your folders` : ""}`,
          result: { path: finalPath, name: finalName, files },
        };
      } catch (e) {
        await inDir(parent.real, null, (d) => fs.promises.rm(d.at(tempName), { recursive: true, force: true })).catch(() => {});
        throw e;
      } finally {
        await into.close();
      }
    },
    { action: "files.extract", target: t.real },
  );
}
