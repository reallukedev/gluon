import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { host, lineReader, CommandError } from "../host/exec";
import { AppError } from "../errors";
import { recentDockerEvents, explainExit, type DockerEvent } from "../docker/events";
import type { LogEntry, LogLevel } from "@/lib/diagnostics-types";

/**
 * Kernel log and system journal via `journalctl -o json` on the host, and Docker events, normalised
 * to { time, source, level, message }.
 */

export const LEVELS: LogLevel[] = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];
export const UNIT_RE = /^[A-Za-z0-9@._:\\-]{1,128}$/;

export interface JournalQuery {
  kernel: boolean;
  unit?: string;
  /** 0–7: show this priority and more severe. */
  priority?: number;
  lines: number;
}

function args(q: JournalQuery): string[] {
  const a = ["-o", "json", "--no-pager", "--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID,_COMM,_TRANSPORT"];
  if (q.kernel) a.push("-k");
  if (q.unit) {
    if (!UNIT_RE.test(q.unit)) throw new AppError("invalid", "That doesn't look like a service name.", 400);
    a.push("-u", q.unit);
  }
  if (q.priority !== undefined) a.push("-p", String(Math.max(0, Math.min(7, Math.floor(q.priority)))));
  return a;
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  // Non-UTF-8 messages come back as byte arrays.
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return Buffer.from(v as number[]).toString("utf8");
  if (Array.isArray(v)) return v.map(text).join(" ");
  return v === undefined || v === null ? "" : String(v);
}

export function parseJournalLine(line: string, kernel: boolean): LogEntry | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const us = Number(text(j.__REALTIME_TIMESTAMP));
  const prio = Number(text(j.PRIORITY));
  const pid = Number(text(j._PID));
  const unit = text(j._SYSTEMD_UNIT) || null;
  const ident = text(j.SYSLOG_IDENTIFIER) || text(j._COMM) || null;
  const isKernel = kernel || text(j._TRANSPORT) === "kernel";
  return {
    time: Number.isFinite(us) && us > 0 ? Math.floor(us / 1000) : Date.now(),
    source: isKernel ? "kernel" : "journal",
    level: LEVELS[Number.isFinite(prio) ? Math.max(0, Math.min(7, prio)) : 6]!,
    message: text(j.MESSAGE).replace(/\s+$/, "").slice(0, 4000),
    unit,
    identifier: isKernel ? "kernel" : ident,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    cursor: text(j.__CURSOR) || null,
  };
}

function missingJournal(e: unknown): never {
  if (e instanceof CommandError && (e.code === 127 || /No such file|not found/i.test(e.stderr))) {
    throw new AppError("no_journal", "This machine doesn't have journalctl, so Gluon can't show the system log.", 501);
  }
  throw e;
}

/** The last `lines` entries (oldest first). */
export async function journalSnapshot(q: JournalQuery): Promise<LogEntry[]> {
  const a = [...args(q), "-n", String(Math.max(1, Math.min(2000, q.lines)))];
  let stdout = "";
  try {
    ({ stdout } = await host("journalctl", a, { timeoutMs: 20_000, maxBuffer: 48 * 1024 * 1024, okCodes: [1] }));
  } catch (e) {
    missingJournal(e);
  }
  const out: LogEntry[] = [];
  for (const l of stdout.split("\n")) {
    if (!l) continue;
    const e = parseJournalLine(l, q.kernel);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Follow new entries. journalctl is exec'd directly in the host's namespaces (no PID-namespace
 * fork), so killing our child really stops it.
 */
export function journalFollow(q: JournalQuery & { afterCursor?: string | null }, onEntry: (e: LogEntry) => void, onEnd: (err?: string) => void): () => void {
  // Continue exactly after the snapshot's last entry when we have its cursor (no gap, no duplicates).
  const cursor = q.afterCursor && /^[A-Za-z0-9=;_-]{1,512}$/.test(q.afterCursor) ? q.afterCursor : null;
  const a = [...args(q), "-f", ...(cursor ? [`--after-cursor=${cursor}`] : ["-n", "0"])];
  const noNs = (process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1";
  const cmd = noNs ? "journalctl" : "nsenter";
  const full = noNs ? a : ["-t", "1", "-m", "-u", "-i", "-n", "--", "journalctl", ...a];
  let child: ChildProcess;
  try {
    child = spawn(cmd, full, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv });
  } catch (e) {
    onEnd((e as Error).message);
    return () => undefined;
  }
  let stopped = false;
  let stderr = "";
  const reader = lineReader((l) => {
    if (!l) return;
    const e = parseJournalLine(l, q.kernel);
    if (e) onEntry(e);
  });
  child.stdout?.on("data", (c: Buffer) => reader.push(c));
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-2000);
  });
  child.on("error", (e) => {
    if (!stopped) onEnd(e.message);
  });
  child.on("close", (code) => {
    reader.flush();
    if (!stopped) onEnd(code ? stderr.trim().split("\n").at(-1) || `journalctl exited with ${code}` : undefined);
  });
  return () => {
    stopped = true;
    try {
      child.stdout?.destroy();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000).unref?.();
    } catch {
      /* gone */
    }
  };
}

/** Units that have journal entries (for the filter menu). */
export async function journalUnits(): Promise<string[]> {
  let stdout = "";
  try {
    ({ stdout } = await host("journalctl", ["--field=_SYSTEMD_UNIT", "--no-pager"], { timeoutMs: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (e) {
    missingJournal(e);
  }
  return [...new Set(stdout.split("\n").map((s) => s.trim()))]
    .filter((u) => u && UNIT_RE.test(u) && !/^(session-\d+\.scope|user@\d+\.service|run-.*\.scope|docker-[0-9a-f]{64}\.scope)$/.test(u))
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- docker events

export function dockerEventEntry(ev: DockerEvent): LogEntry {
  const who = ev.name || ev.id.slice(0, 12);
  let message: string;
  let level: LogLevel = "info";
  switch (ev.action) {
    case "die":
      message = `${who} ${explainExit(ev.exitCode)}`;
      level = ev.exitCode && ev.exitCode !== 143 ? "error" : "notice";
      break;
    case "oom":
      message = `${who} ran out of memory`;
      level = "error";
      break;
    case "health_status: unhealthy":
      message = `${who} is failing its health check`;
      level = "warning";
      break;
    case "health_status: healthy":
      message = `${who} is healthy again`;
      break;
    case "kill":
      message = `${who} was sent a stop signal`;
      level = "notice";
      break;
    default:
      message = `${who}: ${ev.action.replace(/^health_status: /, "health ")}`;
  }
  return { time: ev.t, source: "docker", level, message: ev.project && ev.project !== ev.name ? `${message} (${ev.project})` : message, unit: ev.project, identifier: ev.name || null, pid: null, cursor: null };
}

export function dockerEventsSnapshot(limit = 300): LogEntry[] {
  return recentDockerEvents().slice(-limit).map(dockerEventEntry);
}
