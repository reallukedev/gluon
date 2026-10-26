import "server-only";
import fs from "node:fs";
import path from "node:path";

/** Raw readers for /proc and /sys. /proc/stat, meminfo, loadavg are host-wide; net uses PID 1's namespace. */

const read = (p: string) => fs.readFileSync(p, "utf8");
const tryRead = (p: string) => {
  try {
    return read(p);
  } catch {
    return null;
  }
};

export interface CpuTimes {
  total: number;
  idle: number;
  perCore: { total: number; idle: number }[];
}

export function cpuTimes(): CpuTimes {
  const lines = read("/proc/stat").split("\n");
  const parse = (l: string) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = (v[3] ?? 0) + (v[4] ?? 0); // idle + iowait
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0); // exclude guest (already in user)
    return { total, idle };
  };
  const all = parse(lines[0]!);
  const perCore = lines.filter((l) => /^cpu\d+ /.test(l)).map(parse);
  return { ...all, perCore };
}

export function cpuCount(): number {
  return cpuTimes().perCore.length || 1;
}

export interface MemInfo {
  total: number;
  available: number;
  used: number;
  swapTotal: number;
  swapUsed: number;
}

export function memInfo(): MemInfo {
  const kv: Record<string, number> = {};
  for (const l of read("/proc/meminfo").split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]!] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? 0;
  const available = kv.MemAvailable ?? 0;
  return { total, available, used: total - available, swapTotal: kv.SwapTotal ?? 0, swapUsed: (kv.SwapTotal ?? 0) - (kv.SwapFree ?? 0) };
}

export function loadAvg(): [number, number, number] {
  const [a, b, c] = read("/proc/loadavg").split(" ").map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
}

export function uptimeSeconds(): number {
  return Number(read("/proc/uptime").split(" ")[0]);
}

export interface NetCounters {
  iface: string;
  rx: number;
  tx: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
}

export function netDev(pid: number | "self" = 1): NetCounters[] {
  const text = tryRead(`/proc/${pid}/net/dev`);
  if (!text) return [];
  return text
    .split("\n")
    .slice(2)
    .filter(Boolean)
    .map((l) => {
      const [name, rest] = l.split(":");
      const v = (rest ?? "").trim().split(/\s+/).map(Number);
      return { iface: name!.trim(), rx: v[0] ?? 0, rxPackets: v[1] ?? 0, rxErrors: v[2] ?? 0, tx: v[8] ?? 0, txPackets: v[9] ?? 0, txErrors: v[10] ?? 0 };
    });
}

/** Physical-ish interfaces: skip loopback, docker bridges and veths. */
export function isPhysicalIface(name: string) {
  return !/^(lo|docker\d*|br-|veth|virbr|tun|tap|flannel|cni|kube)/.test(name);
}

export interface DiskIo {
  device: string;
  readBytes: number;
  writeBytes: number;
  ioMs: number;
}

export function diskStats(): DiskIo[] {
  const out: DiskIo[] = [];
  for (const l of read("/proc/diskstats").split("\n")) {
    const v = l.trim().split(/\s+/);
    const dev = v[2];
    if (!dev || !/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+|hd[a-z]+)$/.test(dev)) continue;
    out.push({ device: dev, readBytes: Number(v[5]) * 512, writeBytes: Number(v[9]) * 512, ioMs: Number(v[12]) });
  }
  return out;
}

export interface TempSensor {
  chip: string;
  label: string;
  celsius: number;
  high?: number;
  crit?: number;
}

export function temperatures(): TempSensor[] {
  const out: TempSensor[] = [];
  const base = "/sys/class/hwmon";
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(base, d);
    const chip = tryRead(path.join(dir, "name"))?.trim() ?? d;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = f.match(/^temp(\d+)_input$/);
      if (!m) continue;
      const v = Number(tryRead(path.join(dir, f)));
      if (!Number.isFinite(v) || v <= 0) continue;
      const n = m[1];
      const label = tryRead(path.join(dir, `temp${n}_label`))?.trim() ?? `${chip} ${n}`;
      const high = Number(tryRead(path.join(dir, `temp${n}_max`)));
      const crit = Number(tryRead(path.join(dir, `temp${n}_crit`)));
      out.push({ chip, label, celsius: v / 1000, high: high > 0 ? high / 1000 : undefined, crit: crit > 0 ? crit / 1000 : undefined });
    }
  }
  return out;
}

/** The single most meaningful CPU temperature (package/Tctl), if any. */
export function cpuTemperature(sensors = temperatures()): number | null {
  const pick =
    sensors.find((s) => s.chip === "coretemp" && /package/i.test(s.label)) ??
    sensors.find((s) => s.chip === "k10temp" && /tctl|tdie/i.test(s.label)) ??
    sensors.find((s) => /cpu/i.test(s.label)) ??
    sensors.find((s) => s.chip === "coretemp");
  return pick ? pick.celsius : null;
}

// ---- cgroup v2 (with cgroup: host) --------------------------------------------------------

function cgroupDir(containerId: string): string | null {
  for (const p of [`/sys/fs/cgroup/system.slice/docker-${containerId}.scope`, `/sys/fs/cgroup/docker/${containerId}`]) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
  }
  return null;
}

export interface CgroupSample {
  cpuUsec: number;
  memBytes: number;
}

export function cgroupSample(containerId: string): CgroupSample | null {
  const dir = cgroupDir(containerId);
  if (!dir) return null;
  const cpu = tryRead(path.join(dir, "cpu.stat"));
  const mem = tryRead(path.join(dir, "memory.current"));
  const stat = tryRead(path.join(dir, "memory.stat"));
  if (!cpu || !mem) return null;
  const usage = Number(cpu.match(/usage_usec (\d+)/)?.[1] ?? 0);
  // Match `docker stats`: exclude reclaimable page cache.
  const inactive = Number(stat?.match(/^inactive_file (\d+)/m)?.[1] ?? 0);
  return { cpuUsec: usage, memBytes: Math.max(0, Number(mem) - inactive) };
}
