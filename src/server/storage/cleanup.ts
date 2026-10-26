import "server-only";
import fs from "node:fs";
import path from "node:path";
import { host, CommandError } from "../host/exec";
import { hostPath } from "../host/paths";
import { AppError } from "../errors";
import { audit } from "../audit";
import { docker } from "../docker/client";
import { invalidateApps } from "../docker/apps";
import { findLeftovers } from "../alerts/core-checks";
import { formatBytes, listJoin, plural } from "@/lib/format";
import type { User } from "../auth/users";
import { withLock } from "./oplog";
import { hostRealpath, readMountinfo } from "./mounts";

/**
 * Where a folder's bytes really live: links followed, and when it's a bind mount of part of another
 * mounted filesystem (Docker moved to /srv and bound back to /var/lib/docker), that other place.
 */
async function realHome(p: string): Promise<string> {
  const real = await hostRealpath(p);
  try {
    const mounts = readMountinfo();
    const bind = mounts.find((m) => m.target === real && m.fsroot !== "/");
    if (!bind) return real;
    const whole = mounts.find((m) => m.majMin === bind.majMin && m.fsroot === "/");
    return whole ? path.posix.join(whole.target, bind.fsroot) : real;
  } catch {
    return real;
  }
}
import { afterChange, type Where } from "./ops";
import type { CleanupPreview, DockerUsage } from "@/lib/storage-types";

/**
 * Space cleanups, each previewed first: APT's download cache, the systemd journal, and Docker
 * leftovers (dangling images, build cache, stopped containers, unused volumes). Containers and volumes
 * are only removed when named explicitly by the person, from the list they were shown.
 */

function dirBytes(p: string, depth = 0): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(hostPath(p), { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const d of names) {
    const full = path.posix.join(p, d.name);
    try {
      if (d.isDirectory() && depth < 6) {
        const r = dirBytes(full, depth + 1);
        bytes += r.bytes;
        files += r.files;
      } else if (d.isFile()) {
        const st = fs.statSync(hostPath(full));
        bytes += st.blocks * 512;
        files++;
      }
    } catch {
      /* vanished */
    }
  }
  return { bytes, files };
}

function aptCache() {
  const archives = dirBytes("/var/cache/apt/archives");
  let bins = 0;
  for (const n of ["pkgcache.bin", "srcpkgcache.bin"]) {
    try {
      bins += fs.statSync(hostPath(`/var/cache/apt/${n}`)).blocks * 512;
    } catch {
      /* not there */
    }
  }
  return { bytes: archives.bytes + bins, files: archives.files };
}

function parseSize(s: string): number | null {
  const m = s.match(/([\d.]+)\s*([KMGTP]?)(i?B)?/i);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(Number(m[1]) * (mult[m[2]!.toUpperCase()] ?? 1));
}

async function journalBytes(): Promise<number> {
  try {
    const { stdout } = await host("journalctl", ["--disk-usage", "-q"], { timeoutMs: 20_000 });
    const m = stdout.match(/take up (.+?) in the file system/);
    const n = m ? parseSize(m[1]!) : null;
    if (n !== null) return n;
  } catch {
    /* fall back to measuring */
  }
  return dirBytes("/var/log/journal").bytes + dirBytes("/run/log/journal").bytes;
}

const isDanglingImage = (i: { RepoTags?: string[] | null }) => !i.RepoTags?.length || i.RepoTags.every((t) => t === "<none>:<none>");
const isAnonymousVolume = (name: string) => /^[0-9a-f]{64}$/.test(name);

interface DfImage {
  Id: string;
  Size?: number;
  SharedSize?: number;
  Containers?: number;
  RepoTags?: string[] | null;
  Created?: number;
}
interface DfContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  SizeRw?: number;
  Labels?: Record<string, string>;
}
interface DfVolume {
  Name: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  UsageData?: { RefCount?: number; Size?: number } | null;
}
interface DfBuild {
  ID: string;
  InUse?: boolean;
  Shared?: boolean;
  Size?: number;
}
interface Df {
  LayersSize?: number;
  Images?: DfImage[] | null;
  Containers?: DfContainer[] | null;
  Volumes?: DfVolume[] | null;
  BuildCache?: DfBuild[] | null;
}

async function dockerDf(): Promise<Df> {
  return (await docker().df()) as Df;
}

export function summarizeDocker(df: Df): DockerUsage {
  const images = df.Images ?? [];
  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];
  const build = df.BuildCache ?? [];
  const imgBytes = df.LayersSize ?? images.reduce((a, i) => a + (i.Size ?? 0), 0);
  return {
    images: { count: images.length, bytes: imgBytes, reclaimable: images.filter((i) => !i.Containers).reduce((a, i) => a + Math.max(0, (i.Size ?? 0) - (i.SharedSize && i.SharedSize > 0 ? i.SharedSize : 0)), 0) },
    containers: { count: containers.length, bytes: containers.reduce((a, c) => a + (c.SizeRw ?? 0), 0), reclaimable: containers.filter((c) => c.State !== "running").reduce((a, c) => a + (c.SizeRw ?? 0), 0) },
    volumes: {
      count: volumes.length,
      bytes: volumes.reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0),
      reclaimable: volumes.filter((v) => v.UsageData?.RefCount === 0).reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0),
    },
    buildCache: { count: build.length, bytes: build.reduce((a, b) => a + (b.Size ?? 0), 0), reclaimable: build.filter((b) => !b.InUse).reduce((a, b) => a + (b.Size ?? 0), 0) },
  };
}

export async function dockerUsage(): Promise<DockerUsage | null> {
  try {
    return summarizeDocker(await dockerDf());
  } catch {
    return null;
  }
}

export async function cleanupPreview(): Promise<CleanupPreview> {
  const warnings: string[] = [];
  const [journal, df, leftovers, dockerRoot] = await Promise.all([
    journalBytes(),
    dockerDf().catch(() => {
      warnings.push("Gluon couldn't ask Docker how much space it uses.");
      return null;
    }),
    findLeftovers().catch(() => []),
    // Where Docker keeps images and containers on the host, followed to its real folder, so the
    // Space map can hang Docker's cleanup on the right block.
    (docker().info() as Promise<{ DockerRootDir?: string }>)
      .then((i) => (i.DockerRootDir ? realHome(i.DockerRootDir) : null))
      .catch(() => null),
  ]);
  const apt = aptCache();
  let dockerPart: CleanupPreview["docker"] = null;
  if (df) {
    const selfId = (process.env.HOSTNAME ?? "").slice(0, 12);
    dockerPart = {
      usage: summarizeDocker(df),
      danglingImages: (df.Images ?? []).filter((i) => isDanglingImage(i) && !i.Containers).map((i) => ({ id: i.Id, bytes: i.Size ?? 0, created: (i.Created ?? 0) * 1000 })),
      buildCache: { bytes: (df.BuildCache ?? []).filter((b) => !b.InUse).reduce((a, b) => a + (b.Size ?? 0), 0), entries: (df.BuildCache ?? []).filter((b) => !b.InUse).length },
      stoppedContainers: (df.Containers ?? [])
        .filter((c) => c.State === "exited" || c.State === "created" || c.State === "dead")
        .filter((c) => !(selfId && c.Id.startsWith(selfId)))
        .map((c) => ({ id: c.Id, name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""), app: c.Labels?.["com.docker.compose.project"] ?? null, image: c.Image ?? "", status: c.Status ?? c.State ?? "", bytes: c.SizeRw ?? 0 })),
      unusedVolumes: (df.Volumes ?? [])
        .filter((v) => v.UsageData?.RefCount === 0)
        .map((v) => ({ name: v.Name, bytes: v.UsageData?.Size !== undefined && v.UsageData.Size >= 0 ? v.UsageData.Size : null, app: v.Labels?.["com.docker.compose.project"] ?? null, anonymous: isAnonymousVolume(v.Name), created: v.CreatedAt ?? null })),
    };
    if (dockerPart.unusedVolumes.some((v) => !v.anonymous)) {
      warnings.push("Some unused volumes have names: they may hold an app's data (for example an app that is uninstalled or temporarily removed). Only remove the ones you're sure about.");
    }
  }
  const leftoverBytes = leftovers.reduce((a, l) => a + l.bytes, 0);
  return {
    apt,
    journal: { bytes: journal, suggestedKeep: Math.min(Math.max(100 * 1024 * 1024, Math.round(journal / 4)), 500 * 1024 * 1024) },
    docker: dockerPart,
    leftovers: leftovers.length ? { paths: leftovers.map((l) => l.path), bytes: leftoverBytes, sizes: Object.fromEntries(leftovers.map((l) => [l.path, l.bytes])), action: "storage.removeLeftovers" } : null,
    dockerRoot,
    warnings,
  };
}

export type CleanupInput =
  | { kind: "apt" }
  | { kind: "journal"; keepBytes: number }
  | { kind: "docker"; danglingImages: boolean; buildCache: boolean; containers: string[]; volumes: string[] };

function cmdMessage(e: unknown): string {
  if (e instanceof CommandError) return e.stderr.trim().split("\n").pop() || e.message;
  const err = e as { json?: { message?: string }; message?: string };
  return err.json?.message ?? err.message ?? "it didn't work";
}

export async function runCleanup(user: User, input: CleanupInput, where: Where): Promise<{ message: string; freed: number; problems: string[] }> {
  return withLock("cleaning up", async () => {
    let freed = 0;
    const problems: string[] = [];
    let summary = "";
    if (input.kind === "apt") {
      const before = aptCache().bytes;
      try {
        await host("apt-get", ["clean"], { timeoutMs: 5 * 60_000 });
      } catch (e) {
        const msg = cmdMessage(e);
        audit(user, { action: "storage.cleanup.apt", summary: "Tried to clear the package download cache", detail: { error: msg }, outcome: "failed" }, where);
        throw new AppError("cleanup_failed", /lock/i.test(msg) ? "Package updates are running right now, so the cache is locked. Try again when they finish." : `Couldn't clear the package cache: ${msg}`, 409);
      }
      freed = Math.max(0, before - aptCache().bytes);
      summary = `Cleared the package download cache (${formatBytes(freed)})`;
    } else if (input.kind === "journal") {
      const keep = Math.round(input.keepBytes);
      if (!Number.isFinite(keep) || keep < 50 * 1024 * 1024) throw new AppError("invalid", "Keep at least 50 MB of logs so recent problems can still be investigated.");
      const before = await journalBytes();
      try {
        await host("journalctl", [`--vacuum-size=${Math.floor(keep / (1024 * 1024))}M`], { timeoutMs: 5 * 60_000 });
      } catch (e) {
        const msg = cmdMessage(e);
        audit(user, { action: "storage.cleanup.journal", summary: "Tried to shrink the system log", detail: { error: msg }, outcome: "failed" }, where);
        throw new AppError("cleanup_failed", `Couldn't shrink the system log: ${msg}`, 500);
      }
      freed = Math.max(0, before - (await journalBytes()));
      summary = `Shrank the system log to ${formatBytes(keep)} (freed ${formatBytes(freed)})`;
      if (!freed) problems.push("Nothing was removed: the current log file is always kept, and older ones were already under the limit.");
    } else {
      const done: string[] = [];
      const df = await dockerDf();
      if (input.danglingImages) {
        try {
          const r = await docker().pruneImages({ filters: { dangling: ["true"] } });
          freed += r.SpaceReclaimed ?? 0;
          done.push(plural(r.ImagesDeleted?.length ?? 0, "unused image layer"));
        } catch (e) {
          problems.push(`Images: ${cmdMessage(e)}`);
        }
      }
      if (input.buildCache) {
        try {
          const r = await docker().pruneBuilder();
          freed += r.SpaceReclaimed ?? 0;
          done.push("the build cache");
        } catch (e) {
          problems.push(`Build cache: ${cmdMessage(e)}`);
        }
      }
      const selfId = (process.env.HOSTNAME ?? "").slice(0, 12);
      const allowedContainers = new Map((df.Containers ?? []).filter((c) => c.State === "exited" || c.State === "created" || c.State === "dead").map((c) => [c.Id, c]));
      let removedContainers = 0;
      for (const id of input.containers) {
        const c = allowedContainers.get(id);
        if (!c || (selfId && id.startsWith(selfId))) {
          problems.push(`${id.slice(0, 12)} isn't a stopped container any more, so it was left alone.`);
          continue;
        }
        try {
          await docker().getContainer(id).remove({ v: false });
          freed += c.SizeRw ?? 0;
          removedContainers++;
        } catch (e) {
          problems.push(`${(c.Names?.[0] ?? id).replace(/^\//, "")}: ${cmdMessage(e)}`);
        }
      }
      if (removedContainers) done.push(plural(removedContainers, "stopped container"));
      let removedVolumes = 0;
      const unused = new Map((df.Volumes ?? []).filter((v) => v.UsageData?.RefCount === 0).map((v) => [v.Name, v]));
      for (const name of input.volumes) {
        const v = unused.get(name);
        if (!v) {
          problems.push(`${name} is in use or gone, so it was left alone.`);
          continue;
        }
        try {
          await docker().getVolume(name).remove();
          freed += Math.max(0, v.UsageData?.Size ?? 0);
          removedVolumes++;
        } catch (e) {
          problems.push(`${name}: ${cmdMessage(e)}`);
        }
      }
      if (removedVolumes) done.push(plural(removedVolumes, "volume"));
      invalidateApps();
      summary = done.length ? `Removed ${listJoin(done)} (${formatBytes(freed)})` : "Nothing was removed";
    }
    afterChange();
    audit(user, { action: `storage.cleanup.${input.kind}`, summary, detail: { input, freed, problems }, outcome: problems.length && !freed ? "failed" : "ok" }, where);
    return { message: `${summary}.${problems.length ? ` ${problems.join(" ")}` : ""}`, freed, problems };
  });
}
