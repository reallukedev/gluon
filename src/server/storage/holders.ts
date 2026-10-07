import "server-only";
import fs from "node:fs";
import { hostPath, isWithin, readHostFileOr } from "../host/paths";
import { readMountinfo, readSwaps, mountAt, mountsUnder, devNumber } from "./mounts";
import { listContainerRefs, type ContainerRef } from "./compose";
import type { Holder } from "@/lib/storage-types";

/**
 * Who is keeping a filesystem busy: the same thing `fuser -vm` does, done by walking /proc
 * (the host's psmisc isn't installed, and the container has neither fuser nor lsof).
 * A process holds the mount if its cwd, root, executable, an open file or a mapped file lives on
 * the filesystem's device. Running containers that bind a folder from it hold it too, even when idle.
 */

function users(): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of readHostFileOr("/etc/passwd", "").split("\n")) {
    const f = l.split(":");
    if (f.length > 2) m.set(Number(f[2]), f[0]!);
  }
  return m;
}

function containerIdOf(pid: number): string | null {
  try {
    const cg = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const m = cg.match(/docker-([0-9a-f]{64})\.scope/) ?? cg.match(/\/docker\/([0-9a-f]{64})/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function statDev(p: string): number | null {
  try {
    return fs.statSync(p).dev;
  } catch {
    return null;
  }
}

function linkText(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

interface ProcHit {
  pid: number;
  comm: string;
  cmd: string;
  uid: number;
  why: Set<string>;
  paths: string[];
}

function scanProcesses(dev: number, majMinHex: string, maxPids = 20_000): ProcHit[] {
  const hits: ProcHit[] = [];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return hits;
  }
  for (const p of pids.slice(0, maxPids)) {
    const pid = Number(p);
    if (pid === process.pid) continue;
    const base = `/proc/${pid}`;
    const why = new Set<string>();
    const paths: string[] = [];
    for (const [link, label] of [
      ["cwd", "its working folder is there"],
      ["root", "it runs inside it"],
      ["exe", "its program is there"],
    ] as const) {
      const t = linkText(`${base}/${link}`);
      if (t === null) continue;
      if (statDev(`${base}/${link}`) === dev) {
        why.add(label);
        if (paths.length < 3) paths.push(t);
      }
    }
    let fds: string[] = [];
    try {
      fds = fs.readdirSync(`${base}/fd`);
    } catch {
      /* kernel thread or gone */
    }
    for (const fd of fds) {
      const t = linkText(`${base}/fd/${fd}`);
      if (!t || !t.startsWith("/")) continue; // sockets, pipes, anon inodes
      if (statDev(`${base}/fd/${fd}`) === dev) {
        why.add("it has files open there");
        if (paths.length < 3 && !paths.includes(t)) paths.push(t.replace(/ \(deleted\)$/, ""));
      }
    }
    try {
      const maps = fs.readFileSync(`${base}/maps`, "utf8");
      for (const line of maps.split("\n")) {
        const f = line.split(/\s+/);
        if (f[3] === majMinHex && f[5]) {
          why.add("it has files loaded from there");
          if (paths.length < 3 && !paths.includes(f[5])) paths.push(f[5]);
          break;
        }
      }
    } catch {
      /* gone */
    }
    if (!why.size) continue;
    let comm = "";
    let cmd = "";
    let uid = -1;
    try {
      comm = fs.readFileSync(`${base}/comm`, "utf8").trim();
      cmd = fs.readFileSync(`${base}/cmdline`, "utf8").replace(/\0+$/, "").replace(/\0/g, " ").slice(0, 200);
      uid = fs.statSync(base).uid;
    } catch {
      /* gone */
    }
    hits.push({ pid, comm, cmd, uid, why, paths });
  }
  return hits;
}

/** maj:min as it appears in /proc/<pid>/maps ("08:21"). */
function mapsDev(majMin: string): string {
  const [a, b] = majMin.split(":").map(Number) as [number, number];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `${hex(a)}:${hex(b)}`;
}

export interface HolderScan {
  holders: Holder[];
  /** Container ids among the holders (for callers that stop apps first). */
  containerIds: Set<string>;
}

/**
 * Everything using the filesystem mounted at `target`.
 * `ignoreContainers`: containers the caller is about to stop (rename): their processes are skipped.
 */
export async function findHolders(target: string, opts: { ignoreContainers?: Set<string>; containers?: ContainerRef[] } = {}): Promise<HolderScan> {
  const mounts = readMountinfo();
  const m = mountAt(target, mounts);
  const out: Holder[] = [];
  const containerIds = new Set<string>();
  if (!m) return { holders: out, containerIds };

  // Folders from other drives mounted inside it.
  for (const sub of mountsUnder(target, mounts)) {
    if (sub.source.startsWith("/dev/") || sub.fstype === "nfs" || sub.fstype === "cifs" || sub.fstype.startsWith("fuse")) {
      out.push({ kind: "mount", label: `${sub.target} is mounted inside it (${sub.source}). Unmount that first.`, paths: [sub.target] });
    }
  }

  // Swap files and loop devices backed by files on it.
  for (const s of readSwaps()) {
    if (s.startsWith("/") && !s.startsWith("/dev/") && isWithin(s, target)) out.push({ kind: "swap", label: `${s} is being used as swap space.`, paths: [s] });
  }
  try {
    for (const loop of fs.readdirSync("/sys/block").filter((n) => n.startsWith("loop"))) {
      const backing = readHostFileOr(`/sys/block/${loop}/loop/backing_file`, "").trim();
      if (backing && backing.startsWith("/") && isWithin(backing, target)) out.push({ kind: "loop", label: `${backing} is attached as /dev/${loop}.`, paths: [backing] });
    }
  } catch {
    /* no loop devices */
  }

  // Containers binding folders from it.
  let containers = opts.containers;
  if (!containers) {
    try {
      containers = await listContainerRefs();
    } catch {
      containers = [];
    }
  }
  const byId = new Map(containers.map((c) => [c.id, c]));
  for (const c of containers) {
    if (!c.running || opts.ignoreContainers?.has(c.id)) continue;
    const binds = c.binds.filter((b) => b.type === "bind" && b.source.startsWith("/") && isWithin(b.source, target));
    if (!binds.length) continue;
    containerIds.add(c.id);
    const app = c.project ?? c.name;
    out.push({
      kind: "container",
      label: `${app}${c.project && c.service ? ` (${c.service})` : ""} uses ${binds.map((b) => b.source).slice(0, 2).join(" and ")}${binds.length > 2 ? ` and ${binds.length - 2} more` : ""}.`,
      container: { id: c.id, name: c.name, appId: c.project },
      paths: binds.map((b) => b.source),
    });
  }

  // Processes.
  let dev: number | null = null;
  try {
    dev = fs.statSync(hostPath(m.target)).dev;
  } catch {
    dev = devNumber(m.majMin);
  }
  const who = users();
  for (const h of scanProcesses(dev, mapsDev(m.majMin))) {
    const cid = containerIdOf(h.pid);
    if (cid && opts.ignoreContainers?.has(cid)) continue;
    const reason = [...h.why].join(", ");
    const user = who.get(h.uid) ?? (h.uid >= 0 ? String(h.uid) : undefined);
    if (cid) {
      const c = byId.get(cid);
      const existing = out.find((x) => x.kind === "container" && x.container?.id === cid);
      if (existing) {
        existing.paths = [...new Set([...(existing.paths ?? []), ...h.paths])].slice(0, 6);
        continue;
      }
      containerIds.add(cid);
      out.push({
        kind: "container",
        label: `${c ? (c.project ?? c.name) : `Container ${cid.slice(0, 12)}`}: ${h.comm || "a process"} ${reason}.`,
        pid: h.pid,
        command: h.cmd,
        user,
        container: { id: cid, name: c?.name ?? cid.slice(0, 12), appId: c?.project ?? null },
        paths: h.paths,
      });
      continue;
    }
    out.push({
      kind: "process",
      label: `${h.comm || "A process"} (PID ${h.pid}${user ? `, ${user}` : ""}): ${reason}.`,
      pid: h.pid,
      command: h.cmd,
      user,
      paths: h.paths,
    });
  }
  return { holders: out, containerIds };
}
