import "server-only";
import { AppError, notFound } from "../errors";
import { getFinding } from "../findings";
import type { CheckNowResult, MonitorDetail, MonitorInput, MonitorKind, MonitorView } from "@/lib/alerts-types";
import { checkConfig, deleteMonitorRow, getMonitor, insertMonitor, listMonitorRows, parseHostPort, updateMonitorRow, type Monitor } from "./store";
import { clearFindings, downId, flapId, invalidateMonitors, runCheck, runner } from "./runner";
import { emptyStrip, incidents, lastCheck, latencyPercentiles, recentChecks, stateSince, stripsAll, trailingFailures, uptimeAll, type Uptime } from "./stats";

// ---------------------------------------------------------------- views

const NO_UPTIME: Uptime = { h24: null, d7: null, d30: null, d90: null };

function view(m: Monitor, uptime: Uptime, strip: MonitorView["strip"]): MonitorView {
  const st = runner();
  const last = lastCheck(m.id);
  const down = getFinding(downId(m.id));
  const downOpen = !!down && down.resolvedAt === null;
  const flap = getFinding(flapId(m.id));
  const idle = st.idle.has(m.id);
  const state: MonitorView["state"] = !m.enabled ? "paused" : idle ? "idle" : !last ? "pending" : downOpen ? "down" : !last.ok ? "failing" : "up";
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    target: m.target,
    source: m.source,
    ref: m.ref,
    enabled: m.enabled,
    config: m.config,
    createdAt: m.createdAt,
    state,
    since: m.enabled && last && !idle ? stateSince(m.id, last.ok) : null,
    last,
    consecutiveFailures: last && !last.ok ? trailingFailures(m.id) : 0,
    flapping: !!flap && flap.resolvedAt === null,
    uptime,
    latency: latencyPercentiles(m.id),
    strip,
    findingId: downOpen ? down!.id : null,
  };
}

export function listMonitorViews(): MonitorView[] {
  const monitors = listMonitorRows();
  const uptime = uptimeAll();
  const strips = stripsAll(48);
  return monitors.map((m) => view(m, uptime.get(m.id) ?? NO_UPTIME, strips.get(m.id) ?? emptyStrip(48)));
}

export function monitorView(id: string): MonitorView {
  const m = getMonitor(id);
  if (!m) throw notFound("That monitor");
  return view(m, uptimeAll().get(id) ?? NO_UPTIME, stripsAll(48, id).get(id) ?? emptyStrip(48));
}

export function monitorDetail(id: string): MonitorDetail {
  const v = monitorView(id);
  return {
    ...v,
    checks: recentChecks(id, 300),
    incidents: incidents(id),
    week: stripsAll(168, id).get(id) ?? emptyStrip(168),
  };
}

// ---------------------------------------------------------------- mutations

function checkTarget(kind: MonitorKind, target: string) {
  if (kind === "tcp") {
    if (!parseHostPort(target)) throw new AppError("invalid", "Use host:port, e.g. 192.168.1.20:22.", 400, { field: "target" });
    return;
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new AppError("invalid", "That address isn't valid.", 400, { field: "target" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AppError("invalid", "Use an http:// or https:// address.", 400, { field: "target" });
  if (u.username || u.password) throw new AppError("invalid", "Don't put a password in the address; monitors only check that a page answers.", 400, { field: "target" });
}

export function createUserMonitor(input: MonitorInput): Monitor {
  checkTarget(input.kind, input.target);
  const config = checkConfig(input.config as Record<string, unknown>);
  const m = insertMonitor({ name: input.name, kind: input.kind, target: input.target, config, source: "user", ref: null, enabled: input.enabled });
  invalidateMonitors();
  return m;
}

/** Fields a person may change on automatic monitors (the rest follows the route/app). */
const AUTO_EDITABLE = new Set(["intervalSec", "timeoutSec", "failAfter"]);

export function patchMonitor(id: string, patch: { name?: string; kind?: MonitorKind; target?: string; config?: Record<string, unknown>; enabled?: boolean }): { before: Monitor; after: Monitor } {
  const m = getMonitor(id);
  if (!m) throw notFound("That monitor");
  if (m.source === "auto") {
    if (patch.name !== undefined || patch.kind !== undefined || patch.target !== undefined) {
      throw new AppError("auto_monitor", "This monitor follows its app or public address automatically. You can pause it or change how often it checks.", 400);
    }
    const bad = Object.keys(patch.config ?? {}).filter((k) => !AUTO_EDITABLE.has(k));
    if (bad.length) throw new AppError("auto_monitor", "For automatic monitors you can change how often it checks, the timeout, and how many failures count as down.", 400, { field: `config.${bad[0]}` });
  }
  const kind = patch.kind ?? m.kind;
  const target = patch.target ?? m.target;
  if (patch.kind !== undefined || patch.target !== undefined) checkTarget(kind, target);
  const config = patch.config ? checkConfig({ ...m.config, ...patch.config }) : m.config;
  const after = updateMonitorRow(id, { name: patch.name?.trim(), kind, target, config, enabled: patch.enabled });
  invalidateMonitors(id);
  if (patch.enabled === false) clearFindings(id, `Stopped watching ${m.name}`);
  // Retargeting makes old findings meaningless; the next checks decide afresh.
  if (patch.target !== undefined && patch.target !== m.target) clearFindings(id);
  return { before: m, after };
}

export function removeMonitor(id: string): Monitor {
  const m = getMonitor(id);
  if (!m) throw notFound("That monitor");
  if (m.source === "auto") throw new AppError("auto_monitor", "Automatic monitors come and go with their app or public address. Pause it instead.", 400);
  clearFindings(id, `Stopped watching ${m.name}`);
  deleteMonitorRow(id);
  invalidateMonitors(id);
  return m;
}

export async function checkNow(id: string): Promise<CheckNowResult> {
  const m = getMonitor(id);
  if (!m) throw notFound("That monitor");
  const r = await runCheck(m);
  const message = r.ok
    ? `It answered${r.status ? ` ${r.status}` : ""}${r.latencyMs !== null ? ` in ${r.latencyMs} ms` : ""}.`
    : `The check failed: ${r.error}.${m.enabled ? "" : " (The monitor is paused, so this won't raise an alert.)"}`;
  return { at: r.at, ok: r.ok, latencyMs: r.latencyMs, status: r.status, error: r.error, message };
}
