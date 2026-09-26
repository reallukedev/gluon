import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host, CommandError } from "../host/exec";
import { hostExists, hostPath, readHostFileOr } from "../host/paths";
import { all, one, run, tx, now } from "../db";
import { id as newId } from "../crypto";
import { AppError, conflict } from "../errors";
import { publish } from "../events";
import type { AptLockHolder, PendingPackage, RebootStatus, RestartNeeded, UpdateRunSummary } from "@/lib/system-types";
import { friendlyName, isImportant, isValidUnit } from "./units";

/**
 * Debian package updates: what's waiting (`apt list --upgradable` + a dry-run for origins and new
 * packages), refreshing package lists (`apt-get update`), who holds apt's locks, and whether the
 * machine needs a restart. Installing lives in ./apt-runner.ts.
 */

type G = typeof globalThis & {
  __gluonApt?: {
    pending?: { at: number; list: PendingPackage[]; removals: string[] };
    listing?: Promise<{ list: PendingPackage[]; removals: string[] }>;
    refreshing?: Promise<RefreshResult>;
    restartNeeded?: RestartNeeded;
  };
};
const g = globalThis as G;
const state = () => (g.__gluonApt ??= {});

const PENDING_TTL = 10 * 60_000;

// ---------------------------------------------------------------- versions

/** Loose Debian-ish version compare: numeric runs compare as numbers, "~" sorts before anything. */
export function compareVersions(a: string, b: string): number {
  const ta = a.match(/\d+|~|[^\d~]+/g) ?? [];
  const tb = b.match(/\d+|~|[^\d~]+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    if (x === undefined) return y === "~" ? 1 : -1;
    if (y === undefined) return x === "~" ? -1 : 1;
    if (x === "~") return -1;
    if (y === "~") return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
      continue;
    }
    if (nx !== ny) return nx ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- parsing

export interface ListedUpgrade {
  name: string;
  suites: string[];
  candidate: string;
  arch: string;
  current: string;
}

/** `apt list --upgradable`: "libssl3t64/trixie-security 3.5.1-1+deb13u1 amd64 [upgradable from: 3.5.1-1]" */
export function parseAptList(stdout: string): ListedUpgrade[] {
  const out: ListedUpgrade[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([^\s/]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/);
    if (!m) continue;
    out.push({
      name: m[1]!,
      suites: m[2]!.split(",").filter((s) => s && s !== "now"),
      candidate: m[3]!,
      arch: m[4]!,
      current: m[5]!.trim(),
    });
  }
  return out;
}

export interface SimulatedInstall {
  name: string;
  arch: string | null;
  current: string | null;
  candidate: string;
  origins: string[];
}

/**
 * `apt-get -s upgrade`:
 *   Inst libc6 [2.41-12] (2.41-12+deb13u1 Debian:13.2/stable, Debian-Security:13/stable-security [amd64])
 *   Inst linux-image-6.12.108+deb13-amd64 (6.12.108-1 Debian-Security:13/stable-security [amd64])
 *   Remv foo [1.0]
 */
export function parseSimulation(stdout: string): {
  installs: SimulatedInstall[];
  removals: string[];
  keptBack: string[];
} {
  const installs: SimulatedInstall[] = [];
  const removals: string[] = [];
  const keptBack: string[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inst = line.match(/^Inst (\S+) (?:\[([^\]]*)\] )?\((\S+) (.*?) ?\[([^\]]+)\]\)/);
    if (inst) {
      const [name, arch] = inst[1]!.split(":");
      installs.push({
        name: name!,
        arch: arch ?? inst[5] ?? null,
        current: inst[2] || null,
        candidate: inst[3]!,
        origins: inst[4]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      continue;
    }
    const rm = line.match(/^Remv (\S+)/);
    if (rm) {
      removals.push(rm[1]!.split(":")[0]!);
      continue;
    }
    if (/kept back:$|^Not upgrading:$/.test(line.trim())) {
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]!); j++) keptBack.push(...lines[j]!.trim().split(/\s+/));
    }
  }
  return { installs, removals, keptBack };
}

function rebootReason(name: string): PendingPackage["rebootReason"] {
  if (/^linux-(image|modules|signed-image)/.test(name)) return "kernel";
  if (/^(systemd|systemd-sysv|libsystemd0|libsystemd-shared|udev|libudev1)$/.test(name)) return "systemd";
  if (/^(libc6|libc-bin|libc6-[a-z0-9]+)$/.test(name)) return "libc";
  if (/^(firmware-|linux-firmware)/.test(name)) return "firmware";
  if (/-microcode$/.test(name)) return "microcode";
  if (/^(dbus|dbus-daemon|dbus-broker|dbus-system-bus-common)$/.test(name)) return "dbus";
  return null;
}

const isSecurity = (suites: string[], origins: string[]) => suites.some((s) => /-security$/.test(s)) || origins.some((o) => /security/i.test(o));

// ---------------------------------------------------------------- first-seen bookkeeping

interface SeenRow {
  package: string;
  candidate: string;
  security: number;
  first_seen: number;
  security_since: number | null;
}

/** Remember when each waiting update first appeared, so checks can say "waiting for 5 days". */
function trackSeen(pkgs: { name: string; candidate: string; security: boolean }[]): Map<string, SeenRow> {
  const t = now();
  return tx(() => {
    const rows = new Map(all<SeenRow>("SELECT * FROM pending_updates").map((r) => [r.package, r]));
    const keep = new Set<string>();
    for (const p of pkgs) {
      keep.add(p.name);
      const r = rows.get(p.name);
      if (!r) {
        const row: SeenRow = {
          package: p.name,
          candidate: p.candidate,
          security: p.security ? 1 : 0,
          first_seen: t,
          security_since: p.security ? t : null,
        };
        run(
          "INSERT INTO pending_updates (package, candidate, security, first_seen, security_since) VALUES (?, ?, ?, ?, ?)",
          row.package,
          row.candidate,
          row.security,
          row.first_seen,
          row.security_since,
        );
        rows.set(p.name, row);
      } else if (r.candidate !== p.candidate || !!r.security !== p.security) {
        // A newer version replaced the one that was waiting: keep the original clock (you've been
        // behind since then), but start the security clock when it first became a security fix.
        const securitySince = p.security ? (r.security_since ?? t) : null;
        run("UPDATE pending_updates SET candidate = ?, security = ?, security_since = ? WHERE package = ?", p.candidate, p.security ? 1 : 0, securitySince, p.name);
        rows.set(p.name, {
          ...r,
          candidate: p.candidate,
          security: p.security ? 1 : 0,
          security_since: securitySince,
        });
      }
    }
    for (const name of rows.keys()) {
      if (!keep.has(name)) {
        run("DELETE FROM pending_updates WHERE package = ?", name);
        rows.delete(name);
      }
    }
    return rows;
  });
}

// ---------------------------------------------------------------- listing

async function computePending(): Promise<{
  list: PendingPackage[];
  removals: string[];
}> {
  const [listed, sim] = await Promise.all([
    host("apt", ["list", "--upgradable"], { timeoutMs: 90_000 }).then((r) => parseAptList(r.stdout)),
    host("apt-get", ["-s", "-o", "Debug::NoLocking=1", "-o", "APT::Color=0", "--with-new-pkgs", "upgrade"], { timeoutMs: 90_000 })
      .then((r) => parseSimulation(r.stdout))
      .catch((e) => {
        // The dry run is enrichment only (origins, new kernels). A broken dependency state makes it
        // fail; the plain list is still useful.
        console.error("[gluon] apt simulation failed", (e as Error).message);
        return { installs: [], removals: [], keptBack: [] as string[] };
      }),
  ]);
  const simByName = new Map(sim.installs.map((s) => [s.name, s]));
  const listedNames = new Set(listed.map((l) => l.name));
  const simWorked = sim.installs.length > 0 || sim.keptBack.length > 0;

  const merged = [
    ...listed.map((l) => {
      const s = simByName.get(l.name);
      return {
        name: l.name,
        current: l.current,
        candidate: l.candidate,
        arch: l.arch,
        suite: l.suites[0] ?? null,
        origins: s?.origins ?? [],
        security: isSecurity(l.suites, s?.origins ?? []),
        isNew: false,
        heldBack: simWorked && !s,
      };
    }),
    ...sim.installs
      .filter((s) => !listedNames.has(s.name) && !s.current)
      .map((s) => ({
        name: s.name,
        current: null,
        candidate: s.candidate,
        arch: s.arch,
        suite: s.origins[0]?.split("/")[1] ?? null,
        origins: s.origins,
        security: isSecurity([], s.origins),
        isNew: true,
        heldBack: false,
      })),
  ];
  const seen = trackSeen(merged);
  const list: PendingPackage[] = merged
    .map((p) => {
      const reason = rebootReason(p.name);
      return {
        ...p,
        needsReboot: !!reason,
        rebootReason: reason,
        firstSeen: seen.get(p.name)?.first_seen ?? now(),
      };
    })
    .sort((a, b) => Number(b.security) - Number(a.security) || Number(b.needsReboot) - Number(a.needsReboot) || a.name.localeCompare(b.name));
  return { list, removals: sim.removals };
}

/** Waiting updates (cached for 10 minutes; pass fresh after apt-get update or an install). */
export async function pendingUpdates(opts: { fresh?: boolean } = {}): Promise<{ list: PendingPackage[]; removals: string[]; at: number }> {
  const s = state();
  if (!opts.fresh && s.pending && Date.now() - s.pending.at < PENDING_TTL) return s.pending;
  if (s.listing) {
    const r = await s.listing;
    return { ...r, at: s.pending?.at ?? Date.now() };
  }
  s.listing = computePending();
  try {
    const r = await s.listing;
    s.pending = { ...r, at: Date.now() };
    return s.pending;
  } finally {
    s.listing = undefined;
  }
}

export function invalidatePending() {
  const s = state();
  s.pending = undefined;
  s.restartNeeded = undefined;
}

/** Security-clock and oldest-waiting timestamps from the bookkeeping table. */
export function pendingClock(): {
  oldestPendingAt: number | null;
  oldestSecurityAt: number | null;
} {
  const r = one<{ oldest: number | null; sec: number | null }>("SELECT MIN(first_seen) AS oldest, MIN(security_since) AS sec FROM pending_updates");
  return {
    oldestPendingAt: r?.oldest ?? null,
    oldestSecurityAt: r?.sec ?? null,
  };
}

// ---------------------------------------------------------------- locks

const APT_LOCKS = ["/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"];

function devKey(dev: number, ino: number | bigint) {
  // glibc's dev_t encoding → the "MAJ:MIN" /proc/locks prints (hex).
  const major = (Math.floor(dev / 256) & 0xfff) | (Math.floor(dev / 2 ** 32) & ~0xfff);
  const minor = (dev & 0xff) | (Math.floor(dev / 4096) & ~0xff & 0xfffff);
  return `${major.toString(16)}:${minor.toString(16)}:${ino}`;
}

function procComm(pid: number): string {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (cmd.length)
      return cmd
        .map((c) => path.posix.basename(c))
        .slice(0, 4)
        .join(" ")
        .slice(0, 120);
  } catch {
    /* gone */
  }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "unknown";
  }
}

/** Processes holding apt/dpkg locks right now (read from /proc/locks, no fuser/lsof needed). */
export function aptLockHolders(): AptLockHolder[] {
  const targets = new Map<string, string>();
  for (const p of APT_LOCKS) {
    try {
      const st = fs.statSync(hostPath(p));
      targets.set(devKey(st.dev, st.ino), p);
    } catch {
      /* lock file doesn't exist: nobody holds it */
    }
  }
  if (!targets.size) return [];
  let text = "";
  try {
    text = fs.readFileSync("/proc/locks", "utf8");
  } catch {
    return [];
  }
  const out: AptLockHolder[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\d+:\s+(?:->\s+)?\S+\s+\S+\s+\S+\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/i);
    if (!m || line.includes("->")) continue; // "->" lines are waiters, not holders
    const pid = Number(m[1]);
    const key = `${parseInt(m[2]!, 16).toString(16)}:${parseInt(m[3]!, 16).toString(16)}:${m[4]}`;
    const lock = targets.get(key);
    if (!lock || pid <= 0) continue;
    const k = `${pid}:${lock}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ pid, command: procComm(pid), lock });
  }
  return out;
}

export function describeHolders(h: AptLockHolder[]): string {
  const names = [...new Set(h.map((x) => x.command.split(" ")[0]))];
  const who = names.some((n) => /unattended/.test(n ?? ""))
    ? "Automatic updates are running"
    : names.some((n) => /packagekit/i.test(n ?? ""))
      ? "Another program (PackageKit) is installing software"
      : `Another update is running (${names.join(", ")})`;
  return `${who}. Try again when it finishes.`;
}

/** dpkg was interrupted mid-install: files left in /var/lib/dpkg/updates. */
export function dpkgInterrupted(): boolean {
  try {
    return fs.readdirSync(hostPath("/var/lib/dpkg/updates")).some((f) => /^\d+$/.test(f)) && aptLockHolders().length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- refresh (apt-get update)

export interface RefreshResult {
  ok: boolean;
  at: number;
  summary: string;
}

interface RunRow {
  id: string;
  kind: "refresh" | "upgrade" | "repair";
  started_at: number;
  finished_at: number | null;
  user_id: string | null;
  username: string | null;
  packages: string | null;
  outcome: "running" | "ok" | "failed" | "interrupted";
  exit_code: number | null;
  summary: string | null;
  log: string | null;
}

export const toRunSummary = (r: RunRow): UpdateRunSummary => ({
  id: r.id,
  kind: r.kind,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  username: r.username,
  packages: r.packages ? (JSON.parse(r.packages) as string[]) : null,
  outcome: r.outcome,
  exitCode: r.exit_code,
  summary: r.summary,
});

export type { RunRow };

/** Turn apt-get update's complaints into one sentence a person can act on. */
export function explainAptError(out: string): string {
  const resolve = out.match(/Temporary failure resolving '([^']+)'/);
  if (resolve) return `Couldn't look up ${resolve[1]}. The server may be offline or its DNS isn't working.`;
  const connect = out.match(/(?:Could not connect to|Failed to connect to|Unable to connect to) ([^\s:]+)/);
  if (connect) return `Couldn't reach ${connect[1]}. The server may be offline, or that site is down.`;
  if (/NO_PUBKEY|EXPKEYSIG|is not signed|signatures couldn't be verified|signatures were invalid/.test(out)) {
    const src = out.match(/repository '([^']+)'/)?.[1] ?? out.match(/(https?:\/\/\S+)/)?.[1];
    return `A package source's signing key is missing or expired${src ? ` (${src.split(" ")[0]})` : ""}, so its updates can't be trusted.`;
  }
  if (/is not valid yet|Release file .* is expired/.test(out)) return "The package lists' dates don't match the server's clock. Check that the time is right.";
  if (/does not have a Release file|404\s+Not Found/.test(out)) {
    const src = out.match(/repository '([^']+)'/)?.[1] ?? out.match(/(https?:\/\/\S+)/)?.[1];
    return `A package source no longer exists${src ? ` (${src.split(" ")[0]})` : ""}. It may need removing from the apt sources.`;
  }
  if (/No space left on device/.test(out)) return "The disk is full, so the package lists couldn't be saved.";
  if (/Could not get lock|Unable to lock/.test(out)) return "Another update was running at the same time.";
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(E|Err):/.test(l) || /^W: (Failed|Some index)/.test(l));
  return line ? line.replace(/^(E|W|Err):\s*/, "").slice(0, 240) : "apt couldn't refresh the package lists.";
}

/** Run `apt-get update` (one at a time), record it, and re-list waiting updates. */
export async function refreshLists(
  opts: {
    reason: "daily" | "manual" | "retry";
    user?: { id: string; username: string } | null;
  } = { reason: "manual" },
): Promise<RefreshResult> {
  const s = state();
  if (s.refreshing) return s.refreshing;
  const busy = aptLockHolders();
  if (busy.length) throw conflict(describeHolders(busy));
  const active = one<{ id: string }>("SELECT id FROM update_runs WHERE outcome = 'running' AND kind != 'refresh'");
  if (active) throw conflict("Updates are being installed right now. Gluon checks for new ones when that's done.");

  s.refreshing = (async () => {
    const id = newId();
    const started = now();
    run("INSERT INTO update_runs (id, kind, started_at, user_id, username, outcome) VALUES (?, 'refresh', ?, ?, ?, 'running')", id, started, opts.user?.id ?? null, opts.user?.username ?? null);
    let ok = false;
    let output = "";
    let exitCode: number | null = null;
    try {
      // Error-Mode=any makes a failing source an error instead of a warning (ignored by old apt).
      const r = await host("apt-get", ["update", "-q", "-o", "APT::Color=0", "-o", "APT::Update::Error-Mode=any"], { timeoutMs: 10 * 60_000 });
      output = `${r.stdout}\n${r.stderr}`;
      exitCode = 0;
      ok = !/^(E|Err):|^W: (Failed to fetch|Some index files failed)/m.test(output);
    } catch (e) {
      if (e instanceof CommandError) {
        output = `${e.stdout}\n${e.stderr}`;
        exitCode = e.code;
        if (e.code === null) output += "\nE: Timed out after 10 minutes.";
      } else output = (e as Error).message;
    }
    const summary = ok ? "Checked for updates" : explainAptError(output);
    run("UPDATE update_runs SET finished_at = ?, outcome = ?, exit_code = ?, summary = ?, log = ? WHERE id = ?", now(), ok ? "ok" : "failed", exitCode, summary, output.slice(-32_000), id);
    invalidatePending();
    await pendingUpdates({ fresh: true }).catch(() => undefined);
    publish("system.updates", { change: "refreshed", ok });
    return { ok, at: now(), summary };
  })();
  try {
    return await s.refreshing;
  } finally {
    s.refreshing = undefined;
  }
}

export function isRefreshing() {
  return !!state().refreshing;
}

/** Last refresh attempt and last success (ours, or apt's own daily timer). */
export function refreshHistory(): {
  at: number | null;
  ok: boolean | null;
  error: string | null;
  lastSuccessAt: number | null;
  lastFailureSince: number | null;
} {
  const last = one<RunRow>("SELECT * FROM update_runs WHERE kind = 'refresh' AND outcome != 'running' ORDER BY started_at DESC LIMIT 1");
  const lastOk = one<{ at: number }>("SELECT MAX(finished_at) AS at FROM update_runs WHERE kind = 'refresh' AND outcome = 'ok'")?.at ?? null;
  let stamp: number | null = null;
  try {
    stamp = fs.statSync(hostPath("/var/lib/apt/periodic/update-success-stamp")).mtimeMs;
  } catch {
    /* apt's daily timer isn't configured to refresh */
  }
  const lastSuccessAt = Math.max(lastOk ?? 0, stamp ?? 0) || null;
  // When did the current streak of failures start?
  const firstFail = lastOk
    ? (one<{ at: number }>("SELECT MIN(started_at) AS at FROM update_runs WHERE kind = 'refresh' AND outcome = 'failed' AND started_at > ?", lastOk)?.at ?? null)
    : (one<{ at: number }>("SELECT MIN(started_at) AS at FROM update_runs WHERE kind = 'refresh' AND outcome = 'failed'")?.at ?? null);
  return {
    at: last?.finished_at ?? last?.started_at ?? null,
    ok: last ? last.outcome === "ok" : null,
    error: last && last.outcome !== "ok" ? last.summary : null,
    lastSuccessAt,
    lastFailureSince: last && last.outcome !== "ok" ? firstFail : null,
  };
}

/** When the package lists on disk were last rebuilt (apt rewrites pkgcache.bin after every update). */
export function listsUpdatedAt(): number | null {
  let best = 0;
  for (const p of ["/var/cache/apt/pkgcache.bin", "/var/lib/apt/lists", "/var/lib/apt/periodic/update-success-stamp"]) {
    try {
      best = Math.max(best, fs.statSync(hostPath(p)).mtimeMs);
    } catch {
      /* missing */
    }
  }
  return best || null;
}

// ---------------------------------------------------------------- reboot required

function kernelFlavour(release: string): string {
  const variant = release.match(/-(cloud|rt)-/)?.[1] ?? "";
  return `${variant}:${release.split("-").at(-1)}`;
}

function installedKernels(): string[] {
  const out = new Set<string>();
  try {
    for (const f of fs.readdirSync(hostPath("/boot"))) {
      const m = f.match(/^vmlinuz-(.+)$/);
      if (m) out.add(m[1]!);
    }
  } catch {
    /* no /boot access */
  }
  if (!out.size) {
    for (const dir of ["/usr/lib/modules", "/lib/modules"]) {
      try {
        for (const k of fs.readdirSync(hostPath(dir))) if (fs.existsSync(hostPath(`${dir}/${k}/modules.dep`))) out.add(k);
        break;
      } catch {
        /* try the next */
      }
    }
  }
  return [...out];
}

function pid1UsesDeletedLibs(): boolean {
  try {
    return fs
      .readFileSync("/proc/1/maps", "utf8")
      .split("\n")
      .some((l) => l.endsWith(" (deleted)") && /\/(usr\/)?lib(64)?\/.*\.so/.test(l));
  } catch {
    return false;
  }
}

export function rebootStatus(): RebootStatus {
  const running = os.release();
  const flavour = kernelFlavour(running);
  const kernels = installedKernels().filter((k) => kernelFlavour(k) === flavour);
  const newest = kernels.sort(compareVersions).at(-1) ?? null;
  const reasons: string[] = [];
  if (newest && compareVersions(newest, running) > 0) {
    reasons.push(`A newer Linux kernel (${newest.replace(/-[a-z0-9]+$/, "")}) is installed, but the old one (${running.replace(/-[a-z0-9]+$/, "")}) is still running.`);
  }
  let packages: string[] = [];
  let since: number | null = null;
  try {
    since = fs.statSync(hostPath("/run/reboot-required")).mtimeMs;
    packages = readHostFileOr("/run/reboot-required.pkgs", "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    packages = [...new Set(packages)];
    reasons.push(
      packages.length ? `Updates to ${packages.slice(0, 4).join(", ")}${packages.length > 4 ? ` and ${packages.length - 4} more` : ""} asked for a restart.` : "An update asked for a restart.",
    );
  } catch {
    /* no flag file */
  }
  const nr = state().restartNeeded;
  if (nr?.source === "needrestart" && nr.reboot.reasons.length) {
    for (const r of nr.reboot.reasons) if (!reasons.includes(r)) reasons.push(r);
  }
  if (pid1UsesDeletedLibs()) reasons.push("The system manager (systemd) was updated and only picks up the new version after a restart.");
  return {
    required: reasons.length > 0,
    reasons,
    runningKernel: running,
    newestKernel: newest,
    packages,
    since,
  };
}

// ---------------------------------------------------------------- services using old libraries

function unitOfPid(pid: number): string | null {
  try {
    const cg = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const m = cg.match(/^0::\/system\.slice\/(?:.*\/)?([^/]+\.service)(?:\/|$)/m);
    return m && isValidUnit(m[1]) ? m[1]! : null;
  } catch {
    return null;
  }
}

function scanDeletedLibraries(): Pick<RestartNeeded, "services" | "other"> {
  let hostMnt = "";
  try {
    hostMnt = fs.readlinkSync("/proc/1/ns/mnt");
  } catch {
    return { services: [], other: [] };
  }
  const byUnit = new Map<string, { pids: number[]; libs: Set<string> }>();
  const other: RestartNeeded["other"] = [];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return { services: [], other: [] };
  }
  for (const d of pids) {
    const pid = Number(d);
    if (pid === 1) continue;
    try {
      // Only processes that see the host's filesystem (containers have their own libraries).
      if (fs.readlinkSync(`/proc/${pid}/ns/mnt`) !== hostMnt) continue;
      const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
      if (!maps.includes("(deleted)")) continue;
      const libs = new Set<string>();
      for (const l of maps.split("\n")) {
        if (!l.endsWith(" (deleted)")) continue;
        const file = l.slice(l.indexOf("/"), -" (deleted)".length);
        if (/^\/(usr\/)?(lib|lib64|libexec|bin|sbin)\//.test(file) && !/\/(memfd|dev|SYSV)/.test(file)) libs.add(path.posix.basename(file));
      }
      if (!libs.size) continue;
      const unit = unitOfPid(pid);
      if (unit && !/^gluon-/.test(unit)) {
        const e = byUnit.get(unit) ?? { pids: [], libs: new Set<string>() };
        e.pids.push(pid);
        libs.forEach((x) => e.libs.add(x));
        byUnit.set(unit, e);
      } else if (!unit) {
        other.push({
          pid,
          command: procComm(pid),
          libraries: [...libs].slice(0, 8),
        });
      }
    } catch {
      /* exited or unreadable */
    }
  }
  return {
    services: [...byUnit.entries()]
      .map(([unit, e]) => ({
        unit,
        name: friendlyName(unit),
        important: isImportant(unit),
        pids: e.pids.slice(0, 20),
        libraries: [...e.libs].slice(0, 8),
      }))
      .sort((a, b) => Number(b.important) - Number(a.important) || a.name.localeCompare(b.name)),
    other: other.slice(0, 50),
  };
}

async function askNeedrestart(): Promise<RestartNeeded | null> {
  if (!hostExists("/usr/sbin/needrestart")) return null;
  try {
    const { stdout } = await host("needrestart", ["-b", "-r", "l"], {
      timeoutMs: 90_000,
      env: { NEEDRESTART_SUSPEND: "1" },
    });
    const reasons: string[] = [];
    const services: RestartNeeded["services"] = [];
    let kcur = "";
    let kexp = "";
    for (const line of stdout.split("\n")) {
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (k === "NEEDRESTART-KCUR") kcur = v;
      else if (k === "NEEDRESTART-KEXP") kexp = v;
      else if (k === "NEEDRESTART-KSTA" && (v === "2" || v === "3"))
        reasons.push(kexp ? `A newer Linux kernel (${kexp}) is waiting for a restart (running ${kcur || "an older one"}).` : "A newer Linux kernel is waiting for a restart.");
      else if (k === "NEEDRESTART-UCSTA" && v === "2") reasons.push("A processor microcode update is waiting for a restart.");
      else if (k === "NEEDRESTART-SVC" && isValidUnit(v) && !/^gluon-/.test(v))
        services.push({
          unit: v,
          name: friendlyName(v),
          important: isImportant(v),
          pids: [],
          libraries: [],
        });
    }
    const base = rebootStatus();
    return {
      reboot: {
        ...base,
        reasons: [...new Set([...base.reasons, ...reasons])],
        required: base.required || reasons.length > 0,
      },
      services,
      other: [],
      source: "needrestart",
      checkedAt: now(),
    };
  } catch (e) {
    console.error("[gluon] needrestart failed", (e as Error).message);
    return null;
  }
}

/** Reboot status plus services still running old code after an update. Cached for 5 minutes. */
export async function restartNeeded(opts: { fresh?: boolean } = {}): Promise<RestartNeeded> {
  const s = state();
  if (!opts.fresh && s.restartNeeded && Date.now() - s.restartNeeded.checkedAt < 5 * 60_000) return { ...s.restartNeeded, reboot: rebootStatus() };
  const nr = await askNeedrestart();
  const result: RestartNeeded = nr ?? {
    reboot: rebootStatus(),
    ...scanDeletedLibraries(),
    source: "scan",
    checkedAt: now(),
  };
  s.restartNeeded = result;
  return result;
}

export function assertPackageName(p: string) {
  if (!/^[a-z0-9][a-z0-9+.\-]{0,127}(:[a-z0-9\-]{1,32})?$/.test(p)) throw new AppError("invalid_package", `"${p.slice(0, 60)}" isn't a valid package name.`, 400);
}
