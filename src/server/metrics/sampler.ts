import "server-only";
import fs from "node:fs";
import { cpuTimes, memInfo, loadAvg, uptimeSeconds, netDev, isPhysicalIface, diskStats, temperatures, cpuTemperature, cgroupSample, type TempSensor } from "../host/proc";
import { hostPath, readHostFileOr } from "../host/paths";
import { docker } from "../docker/client";
import { publish } from "../events";
import { db, now } from "../db";

export interface HostSample {
  t: number;
  cpu: number;
  cores: number[];
  mem: { used: number; total: number; available: number };
  swap: { used: number; total: number };
  load: [number, number, number];
  uptime: number;
  net: { rx: number; tx: number; ifaces: Record<string, { rx: number; tx: number }> };
  disk: { read: number; write: number; devices: Record<string, { read: number; write: number; busy: number }> };
  temp: number | null;
}

export interface ContainerSample {
  id: string;
  name: string;
  cpu: number; // % of one core ×100 → normalised to % of machine below
  mem: number;
  rx: number | null;
  tx: number | null;
}

export interface FsUsage {
  mount: string;
  device: string;
  fstype: string;
  size: number;
  used: number;
  avail: number;
  /** Percent used the way `df` reports it: used / (used + available to users). */
  pct: number;
}

interface State {
  host: HostSample[];
  containers: { t: number; list: ContainerSample[] }[];
  fs: FsUsage[];
  sensors: TempSensor[];
  prevCpu?: ReturnType<typeof cpuTimes>;
  prevNet?: { t: number; data: ReturnType<typeof netDev> };
  prevDisk?: { t: number; data: ReturnType<typeof diskStats> };
  prevCtr: Map<string, { t: number; cpuUsec: number; rx: number | null; tx: number | null }>;
  minute: Map<string, { sum: number; n: number; max: number }>;
  minuteStart: number;
  pidCache: Map<string, { pid: number; hostNet: boolean; name: string }>;
}

type G = typeof globalThis & { __gluonMetrics?: State };
const g = globalThis as G;
const st = (): State =>
  (g.__gluonMetrics ??= {
    host: [],
    containers: [],
    fs: [],
    sensors: [],
    prevCtr: new Map(),
    minute: new Map(),
    minuteStart: Math.floor(Date.now() / 60_000) * 60_000,
    pidCache: new Map(),
  });

const HOST_KEEP = 180; // 6 min at 2 s
const CTR_KEEP = 120; // 10 min at 5 s

function acc(key: string, v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  const m = st().minute.get(key) ?? { sum: 0, n: 0, max: -Infinity };
  m.sum += v;
  m.n++;
  m.max = Math.max(m.max, v);
  st().minute.set(key, m);
}

function flushMinute(force = false) {
  const s = st();
  const bucket = Math.floor(Date.now() / 60_000) * 60_000;
  if (!force && bucket === s.minuteStart) return;
  const ts = s.minuteStart;
  const rows = [...s.minute.entries()];
  s.minute = new Map();
  s.minuteStart = bucket;
  if (!rows.length) return;
  const ins = db().prepare("INSERT OR REPLACE INTO metrics (key, ts, value) VALUES (?, ?, ?)");
  db().transaction(() => {
    for (const [k, v] of rows) ins.run(k, ts, v.sum / v.n);
  })();
}

// ---------------------------------------------------------------- host

export function sampleHost(): HostSample {
  const s = st();
  const t = Date.now();
  const cpu = cpuTimes();
  let cpuPct = 0;
  let cores: number[] = [];
  if (s.prevCpu) {
    const dt = cpu.total - s.prevCpu.total;
    cpuPct = dt > 0 ? Math.max(0, Math.min(100, (1 - (cpu.idle - s.prevCpu.idle) / dt) * 100)) : 0;
    cores = cpu.perCore.map((c, i) => {
      const p = s.prevCpu!.perCore[i];
      if (!p) return 0;
      const d = c.total - p.total;
      return d > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - p.idle) / d) * 100)) : 0;
    });
  }
  s.prevCpu = cpu;

  const mem = memInfo();

  const net = netDev(1);
  const ifaces: Record<string, { rx: number; tx: number }> = {};
  let rx = 0;
  let tx = 0;
  if (s.prevNet) {
    const dt = (t - s.prevNet.t) / 1000;
    for (const n of net) {
      const p = s.prevNet.data.find((x) => x.iface === n.iface);
      if (!p || dt <= 0) continue;
      const r = { rx: Math.max(0, (n.rx - p.rx) / dt), tx: Math.max(0, (n.tx - p.tx) / dt) };
      ifaces[n.iface] = r;
      if (isPhysicalIface(n.iface)) {
        rx += r.rx;
        tx += r.tx;
      }
    }
  }
  s.prevNet = { t, data: net };

  const disks = diskStats();
  const devices: HostSample["disk"]["devices"] = {};
  let read = 0;
  let write = 0;
  if (s.prevDisk) {
    const dt = (t - s.prevDisk.t) / 1000;
    for (const d of disks) {
      const p = s.prevDisk.data.find((x) => x.device === d.device);
      if (!p || dt <= 0) continue;
      const v = { read: Math.max(0, (d.readBytes - p.readBytes) / dt), write: Math.max(0, (d.writeBytes - p.writeBytes) / dt), busy: Math.min(100, ((d.ioMs - p.ioMs) / (dt * 1000)) * 100) };
      devices[d.device] = v;
      read += v.read;
      write += v.write;
    }
  }
  s.prevDisk = { t, data: disks };

  const sample: HostSample = {
    t,
    cpu: cpuPct,
    cores,
    mem: { used: mem.used, total: mem.total, available: mem.available },
    swap: { used: mem.swapUsed, total: mem.swapTotal },
    load: loadAvg(),
    uptime: uptimeSeconds(),
    net: { rx, tx, ifaces },
    disk: { read, write, devices },
    temp: cpuTemperature(s.sensors.length ? s.sensors : undefined),
  };
  s.host.push(sample);
  if (s.host.length > HOST_KEEP) s.host.shift();

  acc("cpu", cpuPct);
  acc("mem.used", mem.used);
  acc("load1", sample.load[0]);
  acc("net.rx", rx);
  acc("net.tx", tx);
  acc("disk.read", read);
  acc("disk.write", write);
  acc("temp.cpu", sample.temp);
  flushMinute();
  publish("metrics.host", sample);
  return sample;
}

// ---------------------------------------------------------------- containers

async function refreshPids(ids: string[]) {
  const s = st();
  for (const id of ids) {
    if (s.pidCache.has(id)) continue;
    try {
      const info = await docker().getContainer(id).inspect();
      s.pidCache.set(id, { pid: info.State.Pid, hostNet: info.HostConfig.NetworkMode === "host", name: info.Name.replace(/^\//, "") });
    } catch {
      /* gone */
    }
  }
}

export async function sampleContainers(): Promise<ContainerSample[]> {
  const s = st();
  const t = Date.now();
  const running = await docker().listContainers({ all: false });
  const ids = running.map((c) => c.Id);
  for (const k of s.pidCache.keys()) if (!ids.includes(k)) s.pidCache.delete(k);
  await refreshPids(ids);
  const ncpu = s.prevCpu?.perCore.length || 1;
  const list: ContainerSample[] = [];
  for (const c of running) {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const cg = cgroupSample(c.Id);
    if (!cg) continue;
    const meta = s.pidCache.get(c.Id);
    let rxTotal: number | null = null;
    let txTotal: number | null = null;
    if (meta && !meta.hostNet && meta.pid > 0) {
      const nd = netDev(meta.pid).filter((n) => n.iface !== "lo");
      rxTotal = nd.reduce((a, n) => a + n.rx, 0);
      txTotal = nd.reduce((a, n) => a + n.tx, 0);
    }
    const prev = s.prevCtr.get(c.Id);
    let cpu = 0;
    let rx: number | null = null;
    let tx: number | null = null;
    if (prev) {
      const dt = (t - prev.t) / 1000;
      if (dt > 0) {
        cpu = Math.max(0, ((cg.cpuUsec - prev.cpuUsec) / 1e6 / dt / ncpu) * 100);
        if (rxTotal !== null && prev.rx !== null) rx = Math.max(0, (rxTotal - prev.rx) / dt);
        if (txTotal !== null && prev.tx !== null) tx = Math.max(0, (txTotal - prev.tx) / dt);
      }
    }
    s.prevCtr.set(c.Id, { t, cpuUsec: cg.cpuUsec, rx: rxTotal, tx: txTotal });
    list.push({ id: c.Id, name, cpu, mem: cg.memBytes, rx, tx });
    acc(`ctr.${name}.cpu`, cpu);
    acc(`ctr.${name}.mem`, cg.memBytes);
  }
  for (const k of s.prevCtr.keys()) if (!ids.includes(k)) s.prevCtr.delete(k);
  s.containers.push({ t, list });
  if (s.containers.length > CTR_KEEP) s.containers.shift();
  publish("metrics.containers", { t, list });
  return list;
}

// ---------------------------------------------------------------- filesystems

const REAL_FS = new Set(["ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "f2fs", "nfs", "nfs4", "cifs", "smb3", "fuse.mergerfs", "fuse.sshfs"]);

export function sampleFilesystems(): FsUsage[] {
  const mounts = readHostFileOr("/proc/1/mounts", "").split("\n");
  const seen = new Set<string>();
  const out: FsUsage[] = [];
  for (const line of mounts) {
    const [device, rawMount, fstype] = line.split(" ");
    if (!device || !rawMount || !fstype || !REAL_FS.has(fstype)) continue;
    const mount = rawMount.replace(/\\040/g, " ");
    if (mount.startsWith("/proc") || mount.startsWith("/sys") || mount.startsWith("/run") || mount.startsWith("/snap")) continue;
    // Bind mounts show the same device twice; keep the first (shortest) path per device+fs.
    const key = `${device}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const sfs = fs.statfsSync(hostPath(mount));
      const size = sfs.blocks * sfs.bsize;
      const avail = sfs.bavail * sfs.bsize;
      const used = size - sfs.bfree * sfs.bsize;
      out.push({ mount, device, fstype, size, used, avail, pct: used + avail > 0 ? (used / (used + avail)) * 100 : 0 });
      acc(`fs.${mount}.used`, used);
    } catch {
      /* unreadable mount */
    }
  }
  out.sort((a, b) => a.mount.localeCompare(b.mount));
  st().fs = out;
  return out;
}

export function sampleSensors() {
  st().sensors = temperatures();
  return st().sensors;
}

// ---------------------------------------------------------------- reads

export const latestHost = (): HostSample | null => st().host.at(-1) ?? null;
export const hostHistory = (): HostSample[] => st().host;
export const latestContainers = () => st().containers.at(-1) ?? null;
export const containerHistory = () => st().containers;
export const filesystems = (): FsUsage[] => st().fs.map((f) => ({ ...f, pct: f.pct ?? (f.used + f.avail > 0 ? (f.used / (f.used + f.avail)) * 100 : 0) }));
export const sensors = (): TempSensor[] => st().sensors;

/** Minute/hour history for charts. Keys like "cpu", "mem.used", "ctr.jellyfin.cpu", "fs./var.used". */
export function history(keys: string[], rangeMs: number): Record<string, [number, number][]> {
  const since = now() - rangeMs;
  const useHours = rangeMs > 3 * 86_400_000;
  const out: Record<string, [number, number][]> = {};
  const q = useHours
    ? db().prepare("SELECT ts, avg AS value FROM metrics_hour WHERE key = ? AND ts >= ? ORDER BY ts")
    : db().prepare("SELECT ts, value FROM metrics WHERE key = ? AND ts >= ? ORDER BY ts");
  for (const k of keys) {
    let rows = q.all(k, since) as { ts: number; value: number }[];
    if (useHours) {
      // Recent hours not rolled up yet: fold in minute data.
      const minute = db()
        .prepare("SELECT (ts / 3600000) * 3600000 AS ts, AVG(value) AS value FROM metrics WHERE key = ? AND ts >= ? GROUP BY ts / 3600000 ORDER BY ts")
        .all(k, Math.max(since, (rows.at(-1)?.ts ?? since) + 1)) as { ts: number; value: number }[];
      rows = [...rows, ...minute];
    }
    out[k] = rows.map((r) => [r.ts, r.value]);
  }
  return out;
}

/** Hourly rollup + retention. Minute data: 7 days. Hourly: 400 days. */
export function rollup() {
  const cutoff = Math.floor((now() - 2 * 86_400_000) / 3_600_000) * 3_600_000;
  const d = db();
  d.transaction(() => {
    d.prepare(
      `INSERT OR REPLACE INTO metrics_hour (key, ts, avg, max)
       SELECT key, (ts / 3600000) * 3600000 AS h, AVG(value), MAX(value) FROM metrics
       WHERE ts < ? AND ts >= ? GROUP BY key, h`,
    ).run(cutoff, cutoff - 3 * 86_400_000);
    d.prepare("DELETE FROM metrics WHERE ts < ?").run(now() - 7 * 86_400_000);
    d.prepare("DELETE FROM metrics_hour WHERE ts < ?").run(now() - 400 * 86_400_000);
  })();
}

export function flushNow() {
  flushMinute(true);
}
