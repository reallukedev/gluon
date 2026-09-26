import "server-only";
import fs from "node:fs";
import { cpuCount, memInfo } from "../host/proc";
import { readHostFileOr } from "../host/paths";
import { containerIndex, ownerLabel, ownerOfPid } from "./attribution";
import { sharedPoll } from "./poller";
import type { ProcessInfo, ProcessSnapshot } from "@/lib/diagnostics-types";

/**
 * Top processes from /proc (host PID namespace). CPU% comes from utime+stime deltas between samples.
 * Only the top entries get their command line, user and owner looked up.
 */

const CLK_TCK = Number((process.env.GLUON_CLK_TCK ?? process.env.TEND_CLK_TCK) ?? 100);
const PAGE = Number((process.env.GLUON_PAGE_SIZE ?? process.env.TEND_PAGE_SIZE) ?? 4096);
const TOP = 30;

const STATES: Record<string, string> = {
  R: "running",
  S: "sleeping",
  D: "waiting on disk",
  Z: "zombie",
  T: "stopped",
  t: "traced",
  X: "dead",
  I: "idle",
  P: "parked",
  W: "paging",
  K: "wakekill",
};

interface Stat {
  pid: number;
  name: string;
  state: string;
  ppid: number;
  ticks: number;
  threads: number;
  start: number;
  rss: number;
}

function readStat(pid: number): Stat | null {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const f = text.slice(close + 2).split(" ");
  return {
    pid,
    name: text.slice(open + 1, close),
    state: f[0] ?? "?",
    ppid: Number(f[1]),
    ticks: Number(f[11]) + Number(f[12]),
    threads: Number(f[17]),
    start: Number(f[19]),
    rss: Number(f[21]) * PAGE,
  };
}

let bootMs: number | null = null;
function bootTime(): number {
  if (bootMs !== null) return bootMs;
  const m = fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m);
  bootMs = m ? Number(m[1]) * 1000 : 0;
  return bootMs;
}

let users: { at: number; map: Map<number, string> } | null = null;
function userName(uid: number): string {
  if (!users || Date.now() - users.at > 5 * 60_000) {
    const map = new Map<number, string>();
    for (const line of readHostFileOr("/etc/passwd", "").split("\n")) {
      const [name, , id] = line.split(":");
      if (name && id !== undefined) map.set(Number(id), name);
    }
    users = { at: Date.now(), map };
  }
  return users.map.get(uid) ?? String(uid);
}

/** Hide secrets passed as arguments (--password=…, --token …, -p …) so the list is safe to screenshot. */
const SECRET_ARG = /(--?[\w-]*(?:password|passwd|pwd|token|secret|api[-_]?key|identity[-_]?key|auth)[\w-]*)([= ])(\S+)/gi;
export function redactCmd(cmd: string): string {
  return cmd.replace(SECRET_ARG, (_m, flag: string, sep: string) => `${flag}${sep}•••`);
}

function cmdline(pid: number, name: string): string {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const s = redactCmd(raw.replace(/\0+$/, "").replaceAll("\0", " ").trim());
    return s ? (s.length > 300 ? `${s.slice(0, 299)}…` : s) : `[${name}]`;
  } catch {
    return `[${name}]`;
  }
}

function uidOf(pid: number): number {
  try {
    return fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return -1;
  }
}

interface Prev {
  t: number;
  ticks: Map<number, { ticks: number; start: number }>;
}
let prev: Prev | null = null;

function scan(): { t: number; stats: Stat[] } {
  const t = Date.now();
  const stats: Stat[] = [];
  for (const d of fs.readdirSync("/proc")) {
    const c = d.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    const s = readStat(Number(d));
    if (s) stats.push(s);
  }
  return { t, stats };
}

export async function sampleProcesses(): Promise<ProcessSnapshot> {
  if (!prev || Date.now() - prev.t > 10_000) {
    const first = scan();
    prev = { t: first.t, ticks: new Map(first.stats.map((s) => [s.pid, { ticks: s.ticks, start: s.start }])) };
    await new Promise((r) => setTimeout(r, 500));
  }
  const { t, stats } = scan();
  const dt = Math.max(0.1, (t - prev.t) / 1000);
  const cores = cpuCount();
  const mem = memInfo();
  const cpuOf = new Map<number, number>();
  const totals = { processes: stats.length, threads: 0, running: 0, blocked: 0, zombies: 0 };
  for (const s of stats) {
    totals.threads += s.threads || 0;
    if (s.state === "R") totals.running++;
    else if (s.state === "D") totals.blocked++;
    else if (s.state === "Z") totals.zombies++;
    const p = prev.ticks.get(s.pid);
    const d = p && p.start === s.start ? s.ticks - p.ticks : 0;
    cpuOf.set(s.pid, Math.max(0, (d / CLK_TCK / dt) * 100));
  }
  prev = { t, ticks: new Map(stats.map((s) => [s.pid, { ticks: s.ticks, start: s.start }])) };

  const idx = await containerIndex(10_000);
  const boot = bootTime();
  const detail = new Map<number, ProcessInfo>();
  const info = (s: Stat): ProcessInfo => {
    const hit = detail.get(s.pid);
    if (hit) return hit;
    const kernel = s.pid === 2 || s.ppid === 2;
    const owner = kernel ? ({ kind: "process" } as const) : ownerOfPid(s.pid, idx);
    const uid = uidOf(s.pid);
    const core = cpuOf.get(s.pid) ?? 0;
    const v: ProcessInfo = {
      pid: s.pid,
      ppid: s.ppid,
      name: s.name,
      cmd: kernel ? `[${s.name}]` : cmdline(s.pid, s.name),
      user: uid >= 0 ? userName(uid) : "?",
      uid,
      state: s.state,
      stateLabel: STATES[s.state] ?? s.state,
      threads: s.threads,
      cpu: Math.round((core / cores) * 10) / 10,
      cpuCore: Math.round(core * 10) / 10,
      memBytes: s.rss,
      memPct: mem.total ? Math.round((s.rss / mem.total) * 1000) / 10 : 0,
      startedAt: boot ? boot + (s.start / CLK_TCK) * 1000 : null,
      kernel,
      owner,
      ownerLabel: kernel ? "kernel" : ownerLabel(owner, s.name),
    };
    detail.set(s.pid, v);
    return v;
  };
  const byCpu = [...stats].sort((a, b) => (cpuOf.get(b.pid) ?? 0) - (cpuOf.get(a.pid) ?? 0) || b.rss - a.rss).slice(0, TOP).map(info);
  const byMem = [...stats].sort((a, b) => b.rss - a.rss).slice(0, TOP).map(info);
  return { t, totals, cores, memTotal: mem.total, byCpu, byMem };
}

const poll = sharedPoll<ProcessSnapshot>("processes", 2500, sampleProcesses);

export function subscribeProcesses(onData: (s: ProcessSnapshot) => void, onError: (e: Error) => void) {
  return poll.subscribe(onData, onError);
}
