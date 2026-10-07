import "server-only";
import { host } from "../host/exec";
import { readHostFileOr } from "../host/paths";
import { AppError, badRequest } from "../errors";
import { flushNow } from "../metrics/sampler";
import type { PowerImpact, PowerStatus } from "@/lib/system-types";
import { docker } from "../docker/client";
import { listApps } from "../docker/apps";
import { liveLogins } from "./logins";
import { activeRun } from "./apt-runner";
import { rebootStatus } from "./apt";

export type PowerAction = "restart" | "shutdown";

/** A pending `shutdown -r HH:MM`: ask logind, fall back to its state file. */
export async function scheduledShutdown(): Promise<PowerStatus["scheduled"]> {
  try {
    const { stdout } = await host("busctl", ["get-property", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "ScheduledShutdown"], { timeoutMs: 5000 });
    // (st) "reboot" 1790400000000000  : or (st) "" 18446744073709551615 when nothing is scheduled
    const m = stdout.match(/\(st\)\s+"([^"]*)"\s+(\d+)/);
    if (m) {
      const usec = Number(m[2]);
      if (!m[1] || !Number.isFinite(usec) || usec <= 0 || usec >= 2 ** 63) return null;
      return { mode: normaliseMode(m[1]), at: Math.floor(usec / 1000) };
    }
  } catch {
    /* no busctl / logind: try the file */
  }
  const text = readHostFileOr("/run/systemd/shutdown/scheduled", "");
  const usec = Number(text.match(/^USEC=(\d+)/m)?.[1]);
  const mode = text.match(/^MODE=(\S+)/m)?.[1];
  if (!mode || !Number.isFinite(usec) || usec <= 0) return null;
  return { mode: normaliseMode(mode), at: Math.floor(usec / 1000) };
}

function normaliseMode(m: string): string {
  if (m === "dry-reboot" || m === "reboot") return "reboot";
  if (m === "dry-poweroff" || m === "poweroff") return "poweroff";
  return m;
}

type G = typeof globalThis & {
  __gluonRestartPolicy?: { at: number; map: Map<string, string> };
};
const g = globalThis as G;

/** Docker restart policy of each running container ("no", "always", "unless-stopped", "on-failure"). */
async function restartPolicies(ids: string[]): Promise<Map<string, string>> {
  const c = g.__gluonRestartPolicy;
  if (c && Date.now() - c.at < 60_000 && ids.every((id) => c.map.has(id))) return c.map;
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const info = await docker().getContainer(id).inspect();
        map.set(id, info.HostConfig?.RestartPolicy?.Name || "no");
      } catch {
        /* gone */
      }
    }),
  );
  g.__gluonRestartPolicy = { at: Date.now(), map };
  return map;
}

/**
 * What a restart does: which running apps come back on their own (restart policy always /
 * unless-stopped; on-failure doesn't restart after a clean shutdown), and who gets disconnected.
 */
export async function powerImpact(): Promise<PowerImpact | null> {
  try {
    const [apps, live] = await Promise.all([listApps(), liveLogins({ maxAgeMs: 15_000 }).catch(() => null)]);
    const running = apps.filter((a) => !a.self && a.containers.some((c) => c.state === "running"));
    const ids = running.flatMap((a) => a.containers.filter((c) => c.state === "running").map((c) => c.id));
    const policies = await restartPolicies(ids);
    const out = running.map((a) => {
      const ctrs = a.containers.filter((c) => c.state === "running");
      // Umbrel starts its own apps when it comes up, whatever Docker's policy says.
      const umbrel = !!a.umbrel || a.source === "umbrel";
      const staysOff = umbrel ? [] : ctrs.filter((c) => !/^(always|unless-stopped)$/.test(policies.get(c.id) ?? "no")).map((c) => c.service ?? c.name);
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        comesBack: staysOff.length === 0 ? ("yes" as const) : staysOff.length === ctrs.length ? ("no" as const) : ("partly" as const),
        staysOff,
        startedBy: umbrel ? ("umbrel" as const) : ("docker" as const),
      };
    });
    out.sort((a, b) => Number(a.comesBack === "yes") - Number(b.comesBack === "yes") || a.name.localeCompare(b.name));
    const byUser = new Map<string, { user: string; count: number; zone: "home" | "away" | "local" }>();
    for (const s of live?.sessions ?? []) {
      const k = `${s.user}|${s.from.zone}`;
      const cur = byUser.get(k);
      if (cur) cur.count++;
      else byUser.set(k, { user: s.user, count: 1, zone: s.from.zone });
    }
    return { apps: out, sessions: [...byUser.values()] };
  } catch {
    return null;
  }
}

export async function powerStatus(): Promise<PowerStatus> {
  const [scheduled, impact] = await Promise.all([scheduledShutdown(), powerImpact()]);
  return {
    scheduled,
    updateRunning: !!activeRun(),
    reboot: rebootStatus(),
    impact,
  };
}

function guardUpdates(force: boolean) {
  const run = activeRun();
  if (run && !force) {
    throw new AppError("update_running", "Updates are being installed. Restarting now could leave packages half-installed. Wait for them to finish, or confirm to go ahead anyway.", 409, {
      runId: run.id,
    });
  }
}

/**
 * Restart or shut down in 3 seconds. The delay lets this request's response (and the audit entry)
 * reach the person before the machine goes down. The timer lives in the host's systemd, so it fires
 * even though Gluon's own container is stopped along the way.
 */
export async function powerNow(action: PowerAction, opts: { force?: boolean } = {}): Promise<{ at: number }> {
  guardUpdates(!!opts.force);
  flushNow();
  const verb = action === "restart" ? "reboot" : "poweroff";
  const unit = `gluon-power-${Date.now().toString(36)}`;
  try {
    await host(
      "systemd-run",
      [
        `--unit=${unit}`,
        `--description=Gluon: ${action === "restart" ? "restart" : "shut down"} requested from the web`,
        "--on-active=3",
        "--timer-property=AccuracySec=100ms",
        "--",
        "/usr/bin/systemctl",
        verb,
      ],
      { timeoutMs: 15_000 },
    );
  } catch (e) {
    // No systemd-run: fall back to asking systemd directly once the response has gone out.
    console.error("[gluon] systemd-run for power failed, falling back", (e as Error).message);
    setTimeout(
      () =>
        void host("systemctl", [verb, "--no-block"], {
          timeoutMs: 15_000,
        }).catch((err) => console.error("[gluon] power action failed", err)),
      3000,
    );
  }
  return { at: Date.now() + 3000 };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Schedule for the next occurrence of HH:MM in the server's timezone (within 24 hours). */
export async function schedulePower(action: PowerAction, at: string): Promise<PowerStatus["scheduled"]> {
  if (!HHMM.test(at)) throw badRequest("Choose a time like 03:30 (24-hour clock, server time).");
  await host("shutdown", ["--no-wall", action === "restart" ? "-r" : "-P", at], { timeoutMs: 15_000 });
  const s = await scheduledShutdown();
  if (!s) throw new AppError("schedule_failed", "The restart was requested but the server didn't confirm the schedule. Check again in a moment.", 500);
  return s;
}

export async function cancelScheduled(): Promise<boolean> {
  const before = await scheduledShutdown();
  if (!before) return false;
  await host("shutdown", ["-c", "--no-wall"], { timeoutMs: 15_000 });
  return true;
}
