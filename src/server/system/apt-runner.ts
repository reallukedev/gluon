import "server-only";
import fs from "node:fs";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { host, lineReader } from "../host/exec";
import { hostPath } from "../host/paths";
import { one, all, run, now } from "../db";
import { AppError, conflict, badRequest } from "../errors";
import { publish } from "../events";
import { audit, systemEvent } from "../audit";
import { plural } from "@/lib/format";
import type { UpdateRun, UpdateRunSummary } from "@/lib/system-types";
import { aptLockHolders, assertPackageName, describeHolders, dpkgInterrupted, invalidatePending, isRefreshing, pendingUpdates, restartNeeded, toRunSummary, type RunRow } from "./apt";
import { parseShow } from "./units";

/**
 * Installing updates.
 *
 * apt runs as a transient systemd service on the host (`systemd-run`), not as a child of Gluon.
 * Upgrading docker-ce or containerd restarts Docker, which stops Gluon's container; if apt were our
 * child it would be killed mid-install and leave dpkg half-configured. As a systemd unit it keeps
 * going, writes to a log file on the host, and Gluon picks the run back up when it starts again.
 */

const LOG_DIR = "/var/log/gluon";
const MAX_LINES = 3000;
const MAX_STORED_LOG = 1024 * 1024;

const unitName = (id: string) => `gluon-apt-${id}.service`;
const logPath = (id: string) => `${LOG_DIR}/apt-${id}.log`;

interface Follower {
  id: string;
  lines: string[];
  /** Line number of lines[0]. */
  from: number;
  offset: number;
  timer: ReturnType<typeof setInterval> | null;
  lastStateCheck: number;
  checking: boolean;
  finishing: boolean;
  decoder: StringDecoder;
}

type G = typeof globalThis & {
  __gluonAptRuns?: { followers: Map<string, Follower>; starting: boolean };
};
const g = globalThis as G;
const st = () => (g.__gluonAptRuns ??= { followers: new Map(), starting: false });

export const runTopic = (id: string) => `system.apt.${id}`;

export type RunEvent = { type: "line"; n: number; text: string } | { type: "done"; run: UpdateRunSummary };

// ---------------------------------------------------------------- reads

export function getRun(id: string): UpdateRun | null {
  const r = one<RunRow>("SELECT * FROM update_runs WHERE id = ?", id);
  if (!r) return null;
  const f = st().followers.get(id);
  const log = r.outcome === "running" && f ? f.lines.join("\n") : (r.log ?? "");
  return { ...toRunSummary(r), log };
}

export function listRuns(opts: { limit?: number; kind?: "refresh" | "upgrade" | "repair" } = {}): UpdateRunSummary[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const rows = opts.kind
    ? all<RunRow>(
        "SELECT id, kind, started_at, finished_at, user_id, username, packages, outcome, exit_code, summary FROM update_runs WHERE kind = ? ORDER BY started_at DESC LIMIT ?",
        opts.kind,
        limit,
      )
    : all<RunRow>(
        "SELECT id, kind, started_at, finished_at, user_id, username, packages, outcome, exit_code, summary FROM update_runs WHERE kind != 'refresh' ORDER BY started_at DESC LIMIT ?",
        limit,
      );
  return rows.map(toRunSummary);
}

export function activeRun(): UpdateRunSummary | null {
  const r = one<RunRow>("SELECT * FROM update_runs WHERE outcome = 'running' AND kind != 'refresh' ORDER BY started_at DESC LIMIT 1");
  return r ? toRunSummary(r) : null;
}

/** Current buffered lines for a running run (for SSE snapshots). */
export function runBuffer(id: string): { lines: string[]; from: number } | null {
  const f = st().followers.get(id);
  return f ? { lines: f.lines.slice(), from: f.from } : null;
}

// ---------------------------------------------------------------- start

export interface StartOptions {
  kind: "upgrade" | "repair";
  /** Only these packages (null = everything waiting). */
  packages: string[] | null;
}

export async function startRun(user: { id: string; username: string }, opts: StartOptions, where: { ip?: string; zone?: string }): Promise<UpdateRunSummary> {
  const s = st();
  if (s.starting) throw conflict("Updates are already starting.");
  s.starting = true;
  try {
    const current = activeRun();
    if (current) throw new AppError("busy", "Updates are already being installed. You can follow along in System → Updates.", 409, { runId: current.id });
    if (isRefreshing()) throw conflict("Gluon is checking for updates right now. Try again in a moment.");
    const holders = aptLockHolders();
    if (holders.length)
      throw new AppError("apt_busy", describeHolders(holders), 409, {
        holders,
      });

    let packages: string[] | null = null;
    let count = 0;
    if (opts.kind === "upgrade") {
      if (dpkgInterrupted()) throw new AppError("dpkg_interrupted", "A previous update was interrupted. Run Repair first so the half-installed packages get finished.", 409);
      const pending = await pendingUpdates({ fresh: true });
      if (opts.packages?.length) {
        const known = new Set(pending.list.map((p) => p.name));
        const unique = [...new Set(opts.packages)];
        for (const p of unique) {
          assertPackageName(p);
          if (!known.has(p)) throw badRequest(`${p} doesn't have an update waiting any more. Refresh the list and try again.`);
        }
        // New packages (e.g. a new kernel) come in through the package that needs them.
        packages = unique.filter((p) => !pending.list.find((x) => x.name === p)?.isNew);
        if (!packages.length) throw badRequest("Choose at least one installed package to update.");
        count = packages.length;
      } else {
        count = pending.list.filter((p) => !p.heldBack).length;
        if (!count) throw new AppError("up_to_date", "Everything is already up to date.", 409);
      }
    }

    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    fs.mkdirSync(hostPath(LOG_DIR), { recursive: true, mode: 0o750 });
    const log = logPath(id);
    fs.writeFileSync(hostPath(log), "", { mode: 0o640 });

    const aptOpts = ["-y", "-q", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Use-Pty=0", "-o", "APT::Color=0", "-o", "Dpkg::Progress-Fancy=0"];
    const argv =
      opts.kind === "repair"
        ? ["/usr/bin/dpkg", "--configure", "-a", "--force-confdef", "--force-confold"]
        : packages
          ? ["/usr/bin/apt-get", ...aptOpts, "--only-upgrade", "install", ...packages]
          : ["/usr/bin/apt-get", ...aptOpts, "--with-new-pkgs", "upgrade"];

    run(
      "INSERT INTO update_runs (id, kind, started_at, user_id, username, packages, outcome) VALUES (?, ?, ?, ?, ?, ?, 'running')",
      id,
      opts.kind,
      now(),
      user.id,
      user.username,
      packages ? JSON.stringify(packages) : null,
    );

    try {
      await host(
        "systemd-run",
        [
          `--unit=${unitName(id)}`,
          `--description=Gluon: ${opts.kind === "repair" ? "repairing interrupted updates" : "installing updates"}`,
          "--property=RemainAfterExit=yes",
          `--property=StandardOutput=append:${log}`,
          `--property=StandardError=append:${log}`,
          "--setenv=DEBIAN_FRONTEND=noninteractive",
          "--setenv=APT_LISTCHANGES_FRONTEND=none",
          "--setenv=NEEDRESTART_MODE=l",
          "--setenv=UCF_FORCE_CONFFOLD=1",
          "--setenv=LANG=C.UTF-8",
          "--setenv=LC_ALL=C.UTF-8",
          "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "--",
          ...argv,
        ],
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      run("UPDATE update_runs SET outcome = 'failed', finished_at = ?, summary = ? WHERE id = ?", now(), "Couldn't start the update.", id);
      try {
        fs.unlinkSync(hostPath(log));
      } catch {
        /* ignore */
      }
      audit(
        user,
        {
          action: `system.updates.${opts.kind}`,
          target: "apt",
          summary: "Tried to start installing updates",
          detail: { packages, error: (e as Error).message },
          outcome: "failed",
        },
        where,
      );
      throw new AppError("start_failed", "Gluon couldn't start the update on the host. Nothing was installed.", 500, { error: (e as Error).message });
    }

    const summary =
      opts.kind === "repair"
        ? "Started repairing interrupted updates"
        : packages
          ? `Started updating ${packages.length <= 3 ? packages.join(", ") : plural(packages.length, "package")}`
          : `Started installing ${plural(count, "update")}`;
    audit(
      user,
      {
        action: `system.updates.${opts.kind}`,
        target: "apt",
        summary,
        detail: { runId: id, packages },
      },
      where,
    );
    publish("system.updates", { change: "started", runId: id });
    follow(id);
    return activeRun() ?? toRunSummary(one<RunRow>("SELECT * FROM update_runs WHERE id = ?", id)!);
  } finally {
    s.starting = false;
  }
}

// ---------------------------------------------------------------- follow

function readNew(f: Follower, push: (text: string) => void) {
  let fd: number | null = null;
  try {
    fd = fs.openSync(hostPath(logPath(f.id)), "r");
    const size = fs.fstatSync(fd).size;
    if (size < f.offset) f.offset = 0; // truncated/replaced
    while (f.offset < size) {
      const len = Math.min(256 * 1024, size - f.offset);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, f.offset);
      if (n <= 0) break;
      f.offset += n;
      push(f.decoder.write(buf.subarray(0, n))); // keeps multi-byte characters split across reads intact
    }
  } catch {
    /* log not there (yet / any more) */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Start (or return) the follower that tails a run's log and notices when it finishes. */
export function follow(id: string): Follower {
  const s = st();
  const existing = s.followers.get(id);
  if (existing) return existing;
  const f: Follower = {
    id,
    lines: [],
    from: 0,
    offset: 0,
    timer: null,
    lastStateCheck: 0,
    checking: false,
    finishing: false,
    decoder: new StringDecoder("utf8"),
  };
  s.followers.set(id, f);
  const reader = lineReader((text) => {
    f.lines.push(text);
    const n = f.from + f.lines.length - 1;
    if (f.lines.length > MAX_LINES) {
      f.lines.shift();
      f.from++;
    }
    publish(runTopic(id), { type: "line", n, text } satisfies RunEvent);
  });
  const tick = async () => {
    if (f.finishing) return;
    readNew(f, (c) => reader.push(c));
    if (f.checking || Date.now() - f.lastStateCheck < 2000) return;
    f.lastStateCheck = Date.now();
    f.checking = true;
    const state = await unitState(id).finally(() => (f.checking = false));
    if (state.done && !f.finishing) {
      f.finishing = true;
      readNew(f, (c) => reader.push(c));
      reader.flush();
      await finish(f, state).catch((e) => console.error("[gluon] finishing update run failed", e));
    }
  };
  f.timer = setInterval(() => void tick(), 700);
  f.timer.unref?.();
  void tick();
  return f;
}

interface UnitState {
  done: boolean;
  ok: boolean;
  exitCode: number | null;
  known: boolean;
}

async function unitState(id: string): Promise<UnitState> {
  try {
    const { stdout } = await host("systemctl", ["show", unitName(id), "--no-pager", "-p", "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode"], { timeoutMs: 10_000 });
    const r = parseShow(stdout)[0] ?? {};
    const status = r.ExecMainStatus !== undefined && r.ExecMainStatus !== "" ? Number(r.ExecMainStatus) : null;
    if (r.LoadState === "not-found") return { done: true, ok: false, exitCode: null, known: false };
    if (r.ActiveState === "active" && r.SubState === "exited") return { done: true, ok: status === 0, exitCode: status, known: true };
    if (r.ActiveState === "failed") return { done: true, ok: false, exitCode: status, known: true };
    if (r.ActiveState === "inactive")
      return {
        done: true,
        ok: status === 0 && r.Result === "success",
        exitCode: status,
        known: r.Result !== undefined,
      };
    return { done: false, ok: false, exitCode: null, known: true };
  } catch {
    return { done: false, ok: false, exitCode: null, known: true }; // try again next tick
  }
}

/** apt's own tally line → a sentence. */
function summarise(kind: string, log: string, ok: boolean, exitCode: number | null, known: boolean): string {
  if (kind === "repair") return ok ? "Finished the interrupted updates" : "Repair didn't finish. The log shows what went wrong.";
  // apt-get's classic tally, or apt 3's "Summary: Upgrading: 3, Installing: 1, Removing: 0, Not Upgrading: 0".
  const classic = [...log.matchAll(/(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded/g)].at(-1);
  const modern = [...log.matchAll(/Upgrading: (\d+), Installing: (\d+), (?:Reinstalling: \d+, )?Removing: (\d+), Not Upgrading: (\d+)/g)].at(-1);
  const tally = classic ?? modern;
  if (ok) {
    if (!tally) return "Finished installing updates";
    const upgraded = Number(tally[1]);
    const added = Number(tally[2]);
    const removed = Number(tally[3]);
    if (!upgraded && !added) return "Everything was already up to date";
    let s = `Installed ${plural(upgraded + added, "update")}`;
    if (removed) s += `, removed ${plural(removed, "package")}`;
    return s;
  }
  if (!known) return "Gluon lost track of this update (the host may have restarted). Check the list: some updates may have installed.";
  if (/No space left on device/.test(log)) return "The disk filled up during the update. Free some space, then run Repair.";
  if (/dpkg was interrupted/.test(log)) return "A previous update was interrupted. Run Repair, then try again.";
  if (/Could not get lock|Unable to acquire the dpkg frontend lock/.test(log)) return "Another update was running at the same time. Try again when it finishes.";
  if (/Unable to fetch some archives|Failed to fetch|Temporary failure resolving/.test(log)) return "Some packages couldn't be downloaded. Check the internet connection and try again.";
  if (/Sub-process \/usr\/bin\/dpkg returned an error/.test(log)) {
    const pkg = log.match(/Errors were encountered while processing:\s*\n\s*(\S+)/)?.[1];
    return pkg ? `${pkg} failed to install. The log shows why; Repair may fix it.` : "A package failed to install. The log shows why; Repair may fix it.";
  }
  const e = log
    .split("\n")
    .reverse()
    .find((l) => /^E:/.test(l));
  return e ? e.replace(/^E:\s*/, "").slice(0, 200) : `The update stopped with an error${exitCode !== null ? ` (code ${exitCode})` : ""}.`;
}

async function finish(f: Follower, state: UnitState) {
  if (f.timer) clearInterval(f.timer);
  const row = one<RunRow>("SELECT * FROM update_runs WHERE id = ?", f.id);
  if (!row || row.outcome !== "running") {
    st().followers.delete(f.id);
    return;
  }
  let log = "";
  try {
    const full = fs.readFileSync(hostPath(logPath(f.id)), "utf8");
    log = full.length > MAX_STORED_LOG ? `[… ${full.length - MAX_STORED_LOG} earlier characters trimmed …]\n${full.slice(-MAX_STORED_LOG)}` : full;
  } catch {
    log = f.lines.join("\n");
  }
  const outcome = state.ok ? "ok" : state.known ? "failed" : "interrupted";
  const summary = summarise(row.kind, log, state.ok, state.exitCode, state.known);
  run("UPDATE update_runs SET finished_at = ?, outcome = ?, exit_code = ?, summary = ?, log = ? WHERE id = ?", now(), outcome, state.exitCode, summary, log, f.id);
  invalidatePending();

  // Tell listeners first; the follower stays registered until now so nobody starts a second one.
  const summaryRow = toRunSummary(one<RunRow>("SELECT * FROM update_runs WHERE id = ?", f.id)!);
  publish(runTopic(f.id), { type: "done", run: summaryRow } satisfies RunEvent);
  publish("system.updates", { change: "finished", runId: f.id, outcome });
  st().followers.delete(f.id);

  const user = row.user_id ? { id: row.user_id, username: row.username ?? "" } : null;
  const entry = {
    action: `system.updates.${row.kind}.finished`,
    target: "apt",
    summary,
    detail: { runId: f.id, exitCode: state.exitCode },
    outcome: outcome === "ok" ? ("ok" as const) : ("failed" as const),
  };
  if (user) audit(user, entry);
  else systemEvent(entry);

  // Clean up the transient unit and its log file (the log now lives in Gluon's database).
  await host("systemctl", ["stop", unitName(f.id)], {
    timeoutMs: 20_000,
  }).catch(() => undefined);
  await host("systemctl", ["reset-failed", unitName(f.id)], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  try {
    fs.unlinkSync(hostPath(logPath(f.id)));
  } catch {
    /* already gone */
  }

  // Refresh what's waiting and what needs a restart now that packages changed.
  await pendingUpdates({ fresh: true }).catch(() => undefined);
  await restartNeeded({ fresh: true }).catch(() => undefined);
  publish("system.updates", { change: "listed" });
  const { runAllChecks } = await import("../alerts/engine");
  setTimeout(() => void runAllChecks(), 1500);
}

/** On startup: pick up runs that were in progress when Gluon stopped (e.g. Docker was upgraded). */
export function resumeRuns() {
  const rows = all<{ id: string; kind: string }>("SELECT id, kind FROM update_runs WHERE outcome = 'running'");
  for (const r of rows) {
    if (r.kind === "refresh") {
      // apt-get update ran as our child and died with us.
      run("UPDATE update_runs SET outcome = 'interrupted', finished_at = ?, summary = 'Gluon restarted while checking for updates' WHERE id = ?", now(), r.id);
      continue;
    }
    follow(r.id);
  }
}

export function pruneRuns() {
  run("DELETE FROM update_runs WHERE kind = 'refresh' AND started_at < ?", now() - 90 * 86_400_000);
  run("DELETE FROM update_runs WHERE kind != 'refresh' AND outcome != 'running' AND started_at < ?", now() - 400 * 86_400_000);
}
