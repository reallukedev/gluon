import "server-only";
import type { ChildProcess } from "node:child_process";
import { host, hostSpawn, lineReader, CommandError } from "../host/exec";
import { AppError, notFound } from "../errors";
import { publish } from "../events";
import { formatRelative } from "@/lib/format";
import type { JournalEntry, ServiceAction, ServiceDetail, ServiceInfo } from "@/lib/system-types";
import { aboutUnit, blockedReason, friendlyName, isImportant, isValidUnit, parseShow, policyFor, showList, showNumber, showTimestamp, takesGluonDown } from "./units";

// ---------------------------------------------------------------- listing

interface ListedUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

async function listUnits(): Promise<ListedUnit[]> {
  try {
    const { stdout } = await host("systemctl", ["list-units", "--type=service", "--all", "--output=json", "--no-pager"], { timeoutMs: 15_000 });
    const parsed = JSON.parse(stdout) as Partial<ListedUnit>[];
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed
      .filter((u) => typeof u.unit === "string")
      .map((u) => ({
        unit: u.unit!,
        load: u.load ?? "",
        active: u.active ?? "",
        sub: u.sub ?? "",
        description: u.description ?? "",
      }));
  } catch (e) {
    if (e instanceof CommandError && e.code === null) throw e; // timed out: don't try again
    // Older systemd without --output=json: parse the plain table.
    const { stdout } = await host("systemctl", ["list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"], { timeoutMs: 15_000 });
    return stdout
      .split("\n")
      .map((l) => l.replace(/^[●*]\s*/, "").trim())
      .filter(Boolean)
      .map((l) => {
        const [unit = "", load = "", active = "", sub = "", ...rest] = l.split(/\s+/);
        return { unit, load, active, sub, description: rest.join(" ") };
      })
      .filter((u) => u.unit.endsWith(".service"));
  }
}

async function listUnitFiles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { stdout } = await host("systemctl", ["list-unit-files", "--type=service", "--output=json", "--no-pager"], { timeoutMs: 15_000 });
    const parsed = JSON.parse(stdout) as {
      unit_file?: string;
      state?: string;
    }[];
    for (const f of parsed) if (f.unit_file && f.state) out.set(f.unit_file, f.state);
  } catch (e) {
    if (e instanceof CommandError && e.code === null) throw e;
    const { stdout } = await host("systemctl", ["list-unit-files", "--type=service", "--plain", "--no-legend", "--no-pager"], { timeoutMs: 15_000 });
    for (const l of stdout.split("\n")) {
      const [file, state] = l.trim().split(/\s+/);
      if (file && state) out.set(file, state);
    }
  }
  return out;
}

const SHOW_PROPS = [
  "Id",
  "Description",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "MemoryCurrent",
  "CPUUsageNSec",
  "NRestarts",
  "ActiveEnterTimestamp",
  "InactiveEnterTimestamp",
  "Result",
  "ExecMainStatus",
  "CanReload",
  "CanStart",
  "CanStop",
  "FragmentPath",
];

const DETAIL_PROPS = [...SHOW_PROPS, "ExecStart", "User", "WantedBy", "After", "TriggeredBy", "Documentation", "TasksCurrent"];

let timestampFlag: boolean | null = null;

/** `systemctl show` for many units at once, keyed by Id. */
async function show(units: string[], props: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (!units.length) return out;
  const base = ["show", "--no-pager", "-p", props.join(",")];
  const chunks: string[][] = [];
  for (let i = 0; i < units.length; i += 200) chunks.push(units.slice(i, i + 200));
  for (const chunk of chunks) {
    let stdout: string;
    if (timestampFlag !== false) {
      try {
        ({ stdout } = await host("systemctl", [...base, "--timestamp=unix", "--", ...chunk], { timeoutMs: 20_000 }));
        timestampFlag = true;
      } catch (e) {
        if (timestampFlag === true || !(e instanceof CommandError) || e.code === null) throw e;
        timestampFlag = false; // systemd < 248
        ({ stdout } = await host("systemctl", [...base, "--", ...chunk], {
          timeoutMs: 20_000,
        }));
      }
    } else {
      ({ stdout } = await host("systemctl", [...base, "--", ...chunk], {
        timeoutMs: 20_000,
      }));
    }
    const recs = parseShow(stdout);
    // Blocks come back in argument order; key by what we asked for and by the real Id (aliases).
    recs.forEach((r, i) => {
      if (chunk[i]) out.set(chunk[i]!, r);
      if (r.Id) out.set(r.Id, r);
    });
  }
  return out;
}

function toInfo(unit: string, r: Record<string, string>, listed?: ListedUnit, fileState?: string): ServiceInfo {
  const description = r.Description || listed?.description || unit;
  const pol = policyFor(unit);
  const mainPid = showNumber(r.MainPID);
  const exitStatus = showNumber(r.ExecMainStatus);
  return {
    unit,
    name: friendlyName(unit, description),
    description,
    about: aboutUnit(unit),
    load: r.LoadState || listed?.load || "unknown",
    active: r.ActiveState || listed?.active || "unknown",
    sub: r.SubState || listed?.sub || "unknown",
    enabled: r.UnitFileState || fileState || null,
    mainPid: mainPid && mainPid > 0 ? mainPid : null,
    memory: showNumber(r.MemoryCurrent),
    cpuNs: showNumber(r.CPUUsageNSec),
    restarts: showNumber(r.NRestarts),
    activeSince: showTimestamp(r.ActiveEnterTimestamp),
    inactiveSince: showTimestamp(r.InactiveEnterTimestamp),
    result: r.Result || null,
    exitStatus,
    canReload: r.CanReload === "yes",
    canStart: r.CanStart !== "no",
    canStop: r.CanStop !== "no",
    important: isImportant(unit),
    blocked: pol.blocked,
    needsConfirm: pol.needsConfirm,
    needsRecentAuth: pol.needsRecentAuth,
    path: r.FragmentPath || null,
  };
}

type G = typeof globalThis & {
  __gluonServices?: {
    at: number;
    list: ServiceInfo[];
    pending?: Promise<ServiceInfo[]>;
  };
};
const g = globalThis as G;

/** Every systemd service: loaded ones plus installed-but-not-loaded unit files (enabled/disabled/masked). */
export async function listServices(opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<ServiceInfo[]> {
  const c = g.__gluonServices;
  if (!opts.fresh && c && Date.now() - c.at < (opts.maxAgeMs ?? 3000)) return c.list;
  if (c?.pending) return c.pending;
  const pending = (async () => {
    const [units, files] = await Promise.all([listUnits(), listUnitFiles()]);
    const listed = new Map<string, ListedUnit>();
    for (const u of units) {
      if (!isValidUnit(u.unit)) continue;
      // "not-found" entries are references to services that aren't installed; only keep them if they failed.
      if (u.load === "not-found" && u.active !== "failed") continue;
      listed.set(u.unit, u);
    }
    for (const [file, state] of files) {
      if (listed.has(file) || !isValidUnit(file)) continue;
      if (!["enabled", "enabled-runtime", "disabled", "masked", "masked-runtime", "linked", "linked-runtime"].includes(state)) continue;
      listed.set(file, {
        unit: file,
        load: "",
        active: "inactive",
        sub: "dead",
        description: "",
      });
    }
    const names = [...listed.keys()];
    const props = await show(names, SHOW_PROPS);
    const list = names
      .map((n) => {
        const r = props.get(n) ?? {};
        const id = r.Id && isValidUnit(r.Id) ? r.Id : n;
        return toInfo(id, r, listed.get(n), files.get(id) ?? files.get(n));
      })
      // An alias (sshd.service → ssh.service) shows up under the real Id; drop duplicates.
      .filter((s, i, arr) => arr.findIndex((x) => x.unit === s.unit) === i)
      .sort((a, b) => Number(b.important) - Number(a.important) || a.name.localeCompare(b.name));
    g.__gluonServices = { at: Date.now(), list };
    return list;
  })();
  g.__gluonServices = { at: c?.at ?? 0, list: c?.list ?? [], pending };
  try {
    return await pending;
  } finally {
    if (g.__gluonServices?.pending === pending) g.__gluonServices.pending = undefined;
  }
}

export function invalidateServices() {
  if (g.__gluonServices) g.__gluonServices.at = 0;
}

/** Only the failed services (cheap enough for a check every minute). */
export async function failedServices(): Promise<ServiceInfo[]> {
  let names: string[] = [];
  try {
    const { stdout } = await host("systemctl", ["list-units", "--type=service", "--state=failed", "--all", "--output=json", "--no-pager"], { timeoutMs: 15_000 });
    names = (JSON.parse(stdout) as { unit?: string }[]).map((u) => u.unit ?? "");
  } catch (e) {
    if (e instanceof CommandError && e.code === null) throw e;
    const { stdout } = await host("systemctl", ["list-units", "--type=service", "--state=failed", "--all", "--plain", "--no-legend", "--no-pager"], { timeoutMs: 15_000 });
    names = stdout.split("\n").map(
      (l) =>
        l
          .replace(/^[●*]\s*/, "")
          .trim()
          .split(/\s+/)[0] ?? "",
    );
  }
  names = names.filter((n) => isValidUnit(n) && !/^gluon-/.test(n));
  if (!names.length) return [];
  const props = await show(names, SHOW_PROPS);
  return names.map((n) => toInfo(n, props.get(n) ?? {})).filter((s) => s.active === "failed");
}

function execStartText(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/argv\[\]=([^;]*)/);
  return (m ? m[1]! : v).trim() || null;
}

function statusSentence(s: ServiceInfo): string {
  const since = (t: number | null) => (t ? ` since ${formatRelative(t)}` : "");
  if (s.load === "masked" || s.enabled === "masked") return "Masked: it's switched off on purpose and can't be started.";
  if (s.load === "not-found") return "Not installed any more.";
  switch (s.active) {
    case "active":
      return s.sub === "exited" ? `Finished its work${since(s.activeSince)}.` : `Running${since(s.activeSince)}.`;
    case "activating":
      return s.sub === "auto-restart" ? "Crashed and is about to be restarted." : "Starting…";
    case "deactivating":
      return "Stopping…";
    case "reloading":
      return "Reloading its settings…";
    case "failed":
      return `Failed${since(s.inactiveSince)}: ${failureReason(s)}.`;
    default:
      return s.inactiveSince ? `Stopped${since(s.inactiveSince)}.` : "Not running.";
  }
}

/** Why a unit failed, in words. */
export function failureReason(s: Pick<ServiceInfo, "result" | "exitStatus">): string {
  switch (s.result) {
    case "exit-code":
      return s.exitStatus ? `it exited with an error (code ${s.exitStatus})` : "it exited with an error";
    case "signal":
      return "it was killed or crashed";
    case "core-dump":
      return "it crashed";
    case "timeout":
      return "it took too long to start or stop";
    case "oom-kill":
      return "it ran out of memory";
    case "watchdog":
      return "it stopped responding";
    case "start-limit-hit":
      return "it kept failing, so systemd stopped trying";
    case "resources":
      return "something it needs (a file, folder or port) wasn't available";
    case "protocol":
      return "it didn't start the way systemd expected";
    case "exec-condition":
    case "condition":
      return "a start condition wasn't met";
    default:
      return "it stopped unexpectedly";
  }
}

export async function getService(unit: string): Promise<ServiceDetail> {
  const props = await show([unit], DETAIL_PROPS);
  const r = [...props.values()][0];
  if (!r || r.LoadState === "not-found") throw notFound("That service");
  const realUnit = r.Id && isValidUnit(r.Id) ? r.Id : unit;
  const info = toInfo(realUnit, r);
  return {
    ...info,
    execStart: execStartText(r.ExecStart),
    user: r.User || null,
    wantedBy: showList(r.WantedBy),
    after: showList(r.After)
      .filter((u) => !u.startsWith("system"))
      .slice(0, 20),
    triggeredBy: showList(r.TriggeredBy),
    documentation: showList(r.Documentation),
    tasks: showNumber(r.TasksCurrent),
    statusText: statusSentence(info),
  };
}

// ---------------------------------------------------------------- actions

const VERB: Record<ServiceAction, [string, string]> = {
  start: ["Started", "start"],
  stop: ["Stopped", "stop"],
  restart: ["Restarted", "restart"],
  reload: ["Reloaded", "reload"],
  enable: ["Turned on at startup:", "turn on at startup"],
  disable: ["Turned off at startup:", "turn off at startup"],
};

export interface ActionResult {
  message: string;
  service: ServiceInfo | null;
  /** The action was queued (Docker restarts take Gluon down, so we don't wait). */
  queued: boolean;
}

/**
 * Run a service action. Callers must have checked role and, when `policyFor(unit).needsRecentAuth`
 * includes the action, recent authentication.
 */
export async function serviceAction(unit: string, action: ServiceAction, opts: { confirm?: boolean } = {}): Promise<ActionResult> {
  if (!isValidUnit(unit)) throw new AppError("invalid_unit", "That isn't a valid service name.", 400);
  const pol = policyFor(unit);
  if (pol.blocked.includes(action)) throw new AppError("blocked", blockedReason(unit, action), 403);

  const current = [...(await show([unit], SHOW_PROPS)).values()][0];
  if (!current || current.LoadState === "not-found") throw notFound("That service");
  const info = toInfo(unit, current);
  const name = info.name;

  if (pol.needsConfirm.includes(action) && !opts.confirm) {
    throw new AppError(
      "confirm_required",
      `${action === "disable" ? "Turning off" : action === "restart" ? "Restarting" : "Stopping"} ${name} stops every app on this server, including Gluon. Confirm to continue.`,
      409,
      { unit, action },
    );
  }
  if ((info.load === "masked" || info.enabled === "masked") && (action === "start" || action === "restart" || action === "enable")) {
    throw new AppError("masked", `${name} is masked (switched off on purpose), so it can't be started. Unmask it in a terminal first.`, 409);
  }
  if (action === "reload" && !info.canReload) {
    throw new AppError("no_reload", `${name} can't reload its settings in place. Restart it instead.`, 409);
  }
  if ((action === "enable" || action === "disable") && (info.enabled === "static" || info.enabled === "generated" || info.enabled === "transient" || info.enabled === "indirect")) {
    throw new AppError("static", `${name} is started by other parts of the system when needed, so it can't be turned on or off at startup on its own.`, 409);
  }

  const noBlock = takesGluonDown(unit) && (action === "stop" || action === "restart");
  try {
    if ((action === "start" || action === "restart") && info.active === "failed") {
      // A unit that hit its start limit refuses to start until the failure is cleared.
      await host("systemctl", ["reset-failed", "--", unit], {
        timeoutMs: 10_000,
      }).catch(() => undefined);
    }
    const args = [action, ...(noBlock ? ["--no-block"] : []), "--", unit];
    await host("systemctl", args, {
      timeoutMs: action === "enable" || action === "disable" ? 30_000 : 120_000,
    });
  } catch (e) {
    invalidateServices();
    publish("system.services", { unit, action, ok: false });
    if (e instanceof CommandError) {
      const recent = await journal(unit, { lines: 12 }).catch(() => [] as JournalEntry[]);
      const timedOut = e.code === null;
      const msg = timedOut
        ? `${name} is taking too long to ${VERB[action][1]}. It may still finish; check again in a minute.`
        : action === "start" || action === "restart"
          ? `${name} couldn't ${VERB[action][1]}. Its log below usually says why.`
          : `${name} couldn't ${VERB[action][1]}.`;
      throw new AppError("service_failed", msg, 500, {
        unit,
        action,
        stderr: e.stderr.trim().slice(-800),
        log: recent.map((l) => l.message),
      });
    }
    throw e;
  }

  invalidateServices();
  publish("system.services", { unit, action, ok: true });
  if (noBlock) {
    return {
      message: action === "restart" ? `Restarting ${name}. Apps, and Gluon, will be back in a minute or two.` : `Stopping ${name}. Every app, including Gluon, is shutting down.`,
      service: null,
      queued: true,
    };
  }
  const after = [...(await show([unit], SHOW_PROPS)).values()][0];
  const service = after ? toInfo(unit, after) : null;
  if ((action === "start" || action === "restart") && service?.active === "failed") {
    const recent = await journal(unit, { lines: 12 }).catch(() => [] as JournalEntry[]);
    throw new AppError("service_failed", `${name} started but then stopped: ${failureReason(service)}.`, 500, { unit, action, log: recent.map((l) => l.message) });
  }
  const [past] = VERB[action];
  return { message: `${past} ${name}`, service, queued: false };
}

// ---------------------------------------------------------------- journal

const FIELDS = "--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_PID,_COMM";
const CURSOR_RE = /^[A-Za-z0-9=;_\-]{1,400}$/;

function decodeMessage(m: unknown): string {
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    // Binary-safe field: journald sends non-UTF-8 messages as a byte array.
    try {
      return Buffer.from(m as number[]).toString("utf8");
    } catch {
      return "";
    }
  }
  return m === null || m === undefined ? "" : String(m);
}

export function parseJournalLine(line: string): JournalEntry | null {
  if (!line.startsWith("{")) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const us = Number(o.__REALTIME_TIMESTAMP);
    const pid = Number(o._PID);
    const pri = Number(o.PRIORITY);
    return {
      time: Number.isFinite(us) ? Math.floor(us / 1000) : 0,
      priority: Number.isFinite(pri) ? pri : 6,
      message: decodeMessage(o.MESSAGE).replace(/\s+$/, ""),
      identifier: (typeof o.SYSLOG_IDENTIFIER === "string" && o.SYSLOG_IDENTIFIER) || (typeof o._COMM === "string" && o._COMM) || null,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      cursor: typeof o.__CURSOR === "string" ? o.__CURSOR : "",
    };
  } catch {
    return null;
  }
}

export interface JournalQuery {
  lines?: number;
  /** Only entries before this epoch ms (for "load older"). */
  before?: number;
  /** Max priority to include (3 = errors and worse). */
  priority?: number;
  /** Text filter (journalctl --grep, case-insensitive). */
  grep?: string;
}

export async function journal(unit: string, q: JournalQuery = {}): Promise<JournalEntry[]> {
  if (!isValidUnit(unit)) throw new AppError("invalid_unit", "That isn't a valid service name.", 400);
  const lines = Math.max(1, Math.min(2000, q.lines ?? 200));
  const args = ["-u", unit, "-o", "json", "-n", String(lines), "--no-pager", "-q", FIELDS];
  if (q.before) args.push(`--until=@${Math.max(0, q.before - 1) / 1000}`);
  if (q.priority !== undefined) args.push("-p", String(Math.max(0, Math.min(7, Math.floor(q.priority)))));
  // Plain-text search: escape regex syntax so "[error]" or "a+b" match literally.
  if (q.grep) args.push("--case-sensitive=false", `--grep=${q.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const { stdout } = await host("journalctl", args, {
    timeoutMs: 20_000,
    maxBuffer: 32 * 1024 * 1024,
    okCodes: [1],
  });
  return stdout
    .split("\n")
    .map(parseJournalLine)
    .filter((e): e is JournalEntry => !!e);
}

/** Follow a unit's journal. Returns a stop function. */
export function followJournal(unit: string, opts: { afterCursor?: string; backlog?: number }, onEntry: (e: JournalEntry) => void, onEnd: () => void): () => void {
  if (!isValidUnit(unit)) throw new AppError("invalid_unit", "That isn't a valid service name.", 400);
  const args = ["-u", unit, "-o", "json", "-f", "--no-pager", "-q", FIELDS];
  if (opts.afterCursor && CURSOR_RE.test(opts.afterCursor)) args.push(`--after-cursor=${opts.afterCursor}`);
  else args.push("-n", String(Math.max(0, Math.min(500, opts.backlog ?? 0))));
  let child: ChildProcess | null = hostSpawn("journalctl", args);
  const reader = lineReader((l) => {
    const e = parseJournalLine(l);
    if (e) onEntry(e);
  });
  child.stdout?.on("data", (d) => reader.push(d));
  child.on("close", () => {
    reader.flush();
    child = null;
    onEnd();
  });
  child.on("error", () => onEnd());
  return () => {
    child?.kill("SIGTERM");
    child = null;
  };
}

export { CURSOR_RE as JOURNAL_CURSOR_RE };
