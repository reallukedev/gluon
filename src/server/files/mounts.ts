import "server-only";
import fs from "node:fs";
import path from "node:path";
import { hostPath, isWithin, readHostFileOr } from "../host/paths";
import type { FilesystemInfo } from "@/lib/files-types";

/**
 * Read from /proc/1/mountinfo, pid 1's mount namespace, so it's the host's table and not this
 * container's.
 */

export interface MountEntry {
  /** major:minor of the backing device. */
  dev: string;
  /** Path inside the filesystem that is mounted here (not "/" for bind mounts). */
  root: string;
  mount: string;
  fstype: string;
  source: string;
  readOnly: boolean;
}

/** /proc mount files escape space, tab, newline and backslash as octal. */
export function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const a = line.slice(0, sep).split(" ");
    const b = line.slice(sep + 3).split(" ");
    if (a.length < 6 || b.length < 2) continue;
    out.push({
      dev: a[2]!,
      root: unescapeMount(a[3]!),
      mount: unescapeMount(a[4]!),
      // Per-mount "rw" stays when the kernel turns the filesystem itself read-only after errors
      // (errors=remount-ro); that shows only in the super options.
      readOnly: a[5]!.split(",").includes("ro") || (b[2] ?? "").split(",").includes("ro"),
      fstype: b[0]!,
      source: unescapeMount(b[1]!),
    });
  }
  return out;
}

let hostCache: { at: number; list: MountEntry[] } | null = null;

/** Host mounts, cached for 5 s (mounts change rarely, but someone may mount a drive by hand). */
export function hostMounts(): MountEntry[] {
  if (hostCache && Date.now() - hostCache.at < 5000) return hostCache.list;
  const list = parseMountinfo(readHostFileOr("/proc/1/mountinfo", ""));
  hostCache = { at: Date.now(), list };
  return list;
}

let selfCache: MountEntry[] | null = null;
function selfMounts(): MountEntry[] {
  if (!selfCache) {
    try {
      selfCache = parseMountinfo(fs.readFileSync("/proc/self/mountinfo", "utf8"));
    } catch {
      selfCache = [];
    }
  }
  return selfCache;
}

/** The mount (last one wins when stacked) whose mount point is the longest prefix of `p`. */
function containing(list: MountEntry[], p: string): MountEntry | null {
  let best: MountEntry | null = null;
  for (const m of list) {
    if (!isWithin(p, m.mount)) continue;
    if (!best || m.mount.length >= best.mount.length) best = m;
  }
  return best;
}

export function mountOf(p: string): MountEntry | null {
  return containing(hostMounts(), p);
}

/** Every host mount point equal to or below `p` (except `p`'s own mount). */
export function mountsBelow(p: string): MountEntry[] {
  return hostMounts().filter((m) => m.mount !== p && isWithin(m.mount, p) && !isVirtualFs(m.fstype));
}

export function isMountPoint(p: string): boolean {
  return hostMounts().some((m) => m.mount === p);
}

const VIRTUAL = new Set(["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs", "pstore", "efivarfs", "bpf", "autofs", "hugetlbfs", "mqueue", "debugfs", "tracefs", "fusectl", "configfs", "binfmt_misc", "nsfs", "overlay", "rpc_pipefs", "tracefs", "ramfs"]);
export function isVirtualFs(t: string) {
  return VIRTUAL.has(t);
}

/** `/var/lib/docker` on this server is a bind of `/srv/docker`; protecting one must protect the other. */
export function hostAliases(p: string): string[] {
  const m = mountOf(p);
  if (!m) return [p];
  const rel = p === m.mount ? "" : p.slice(m.mount === "/" ? 0 : m.mount.length);
  const internal = path.posix.join(m.root, rel || "/");
  const out = new Set<string>([p]);
  for (const o of hostMounts()) {
    if (o.dev !== m.dev || isVirtualFs(o.fstype)) continue;
    if (!isWithin(internal, o.root)) continue;
    const sub = internal === o.root ? "" : internal.slice(o.root === "/" ? 0 : o.root.length);
    out.add(path.posix.join(o.mount, sub || "/").replace(/(.)\/$/, "$1"));
  }
  return [...out];
}

/** Prefers a host path on the same mount as `near`, so rename(2) works without copying. */
export function containerToHost(p: string, near?: string): string | null {
  const m = containing(selfMounts(), p);
  if (!m) return null;
  const rel = p === m.mount ? "" : p.slice(m.mount === "/" ? 0 : m.mount.length);
  const internal = path.posix.join(m.root, rel || "/");
  const target = near ? mountOf(near) : null;
  let fallback: string | null = null;
  for (const o of hostMounts()) {
    if (o.dev !== m.dev || isVirtualFs(o.fstype)) continue;
    if (!isWithin(internal, o.root)) continue;
    const sub = internal === o.root ? "" : internal.slice(o.root === "/" ? 0 : o.root.length);
    const candidate = path.posix.join(o.mount, sub || "/");
    // Only a candidate whose own containing mount is `o` is reachable as-is (not shadowed).
    if (mountOf(candidate)?.mount !== o.mount) continue;
    if (target && o.mount === target.mount) return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

/**
 * statfs on a hard-mounted share whose server is gone blocks forever (and with it the whole
 * process), so network and FUSE filesystems are only read in the background: a recent answer is
 * used, a stuck or old one reads as unknown.
 */
const REMOTE = /^(nfs4?|cifs|smb3|smbfs|9p|ceph|glusterfs|davfs|fuse(\..+)?)$/;
const REMOTE_STALE_MS = 5 * 60_000;
export const isRemoteFs = (t: string) => REMOTE.test(t);
interface Space {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
}
const remote = new Map<string, { at: number; s: Space | null; pending: boolean }>();

function remoteStatfs(fsPath: string, key: string): Space | null {
  const r = remote.get(key) ?? { at: 0, s: null, pending: false };
  remote.set(key, r);
  if (!r.pending) {
    r.pending = true;
    fs.statfs(fsPath, (err, s) => {
      r.pending = false;
      if (err) return void (r.at = 0);
      r.s = { blocks: s.blocks, bfree: s.bfree, bavail: s.bavail, bsize: s.bsize };
      r.at = Date.now();
    });
  }
  return r.at && Date.now() - r.at < REMOTE_STALE_MS ? r.s : null;
}

/** statfs of the filesystem holding host path `p`, or null when it can't be read (or not without risk of hanging). */
export function hostStatfs(p: string): Space | null {
  const m = mountOf(p);
  try {
    if (m && isRemoteFs(m.fstype)) return remoteStatfs(hostPath(m.mount), `host:${m.mount}`);
    return fs.statfsSync(hostPath(p));
  } catch {
    return null;
  }
}

export function fsInfo(p: string): FilesystemInfo | null {
  const m = mountOf(p);
  if (!m) return null;
  const s = hostStatfs(m.mount);
  if (!s) return null;
  return {
    mount: m.mount,
    device: m.source,
    fstype: m.fstype,
    size: s.blocks * s.bsize,
    used: (s.blocks - s.bfree) * s.bsize,
    avail: s.bavail * s.bsize,
    readOnly: m.readOnly,
  };
}

/** Free bytes available to unprivileged users on the filesystem holding `p` (a host path). */
export function freeBytes(p: string): number | null {
  const s = hostStatfs(p);
  return s ? s.bavail * s.bsize : null;
}

/** For a container-local path (e.g. /data). */
export function localFreeBytes(p: string): number | null {
  const m = containing(selfMounts(), p);
  try {
    const s = m && isRemoteFs(m.fstype) ? remoteStatfs(m.mount, `local:${m.mount}`) : fs.statfsSync(p);
    return s ? s.bavail * s.bsize : null;
  } catch {
    return null;
  }
}
