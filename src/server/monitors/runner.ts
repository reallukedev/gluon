import "server-only";
import { now } from "../db";
import { publish } from "../events";
import { conflict } from "../errors";
import { getFinding, raise, resolve, type FindingInput } from "../findings";
import { getApp, listApps, type AppSummary } from "../docker/apps";
import { getMonitor, listMonitorRows, parseHostPort, type Monitor } from "./store";
import { probeHttp, probeTcp, type ProbeResult } from "./probe";
import { flips, lastCheck, recordCheck, trailingFailures, trailingSuccesses } from "./stats";

/**
 * Scheduler: every monitor runs on its own interval with jitter so checks don't bunch up, at most
 * CONCURRENCY at a time. After each check the down/flapping findings are updated.
 */

const CONCURRENCY = 6;
const FLAP_FLIPS = 4; // passing→failing this many times in an hour = flapping
const FLAP_RECOVER = 3; // successes needed to call it recovered while flapping

interface RunnerState {
  next: Map<string, number>;
  running: Set<string>;
  /** Auto app monitors whose app is stopped on purpose: not checked. */
  idle: Set<string>;
  cache: { at: number; list: Monitor[] } | null;
}
type G = typeof globalThis & { __gluonMonitors?: RunnerState };
const g = globalThis as G;
export const runner = (): RunnerState => (g.__gluonMonitors ??= { next: new Map(), running: new Set(), idle: new Set(), cache: null });

export const downId = (id: string) => `monitor.down:${id}`;
export const flapId = (id: string) => `monitor.flapping:${id}`;

export function invalidateMonitors(id?: string) {
  const st = runner();
  st.cache = null;
  if (id) st.next.delete(id);
}

function monitors(): Monitor[] {
  const st = runner();
  if (st.cache && now() - st.cache.at < 10_000) return st.cache.list;
  const list = listMonitorRows();
  st.cache = { at: now(), list };
  return list;
}

const isAppMonitor = (m: Monitor) => m.source === "auto" && !!m.ref?.startsWith("app:");
const isRouteMonitor = (m: Monitor) => m.source === "auto" && !!m.ref?.startsWith("route:");

/** Close any findings for a monitor (paused, removed, app stopped on purpose). */
export function clearFindings(id: string, note?: string) {
  resolve(downId(id), note);
  resolve(flapId(id));
}

// ---------------------------------------------------------------- findings

function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

async function downFinding(m: Monitor, r: ProbeResult, since: number): Promise<FindingInput> {
  const app = m.config.app ? await getApp(m.config.app).catch(() => null) : null;
  const who = app?.name ?? m.name;
  let title: string;
  let cause: string;
  let remedy: FindingInput["remedy"];
  if (isRouteMonitor(m)) {
    title = `${who} can't be reached at ${hostOf(m.target)}`;
    cause = `Its public address stopped answering (${r.error}).`;
    const lan = app ? monitors().find((x) => x.ref === `app:${app.id}`) : null;
    const lanLast = lan ? lastCheck(lan.id) : null;
    if (lanLast?.ok) cause += " It still works at home, so the problem is between the internet and the server: Caddy, DNS or the router.";
    else if (lanLast && !lanLast.ok) cause += " It isn't answering at home either, so the app itself is the problem.";
    remedy = { action: "", label: "Check the public address", href: `/network?route=${encodeURIComponent(m.ref!.slice(6))}` };
  } else if (isAppMonitor(m)) {
    title = `${who} isn't responding`;
    cause = `It's running but its web page stopped answering (${r.error}).`;
    remedy = app ? { action: "apps.restart", label: `Restart ${app.name}`, params: { id: app.id } } : null;
  } else {
    title = `${m.name} is down`;
    cause = `${m.kind === "tcp" ? m.target : hostOf(m.target)} stopped answering (${r.error}).`;
    remedy = { action: "", label: "See the check history", href: `/alerts?tab=monitors&monitor=${encodeURIComponent(m.id)}` };
  }
  return {
    id: downId(m.id),
    kind: "monitor.down",
    severity: m.config.severity,
    subject: m.config.app ?? null,
    title,
    cause,
    detail: { monitorId: m.id, target: m.target, since, error: r.error, status: r.status },
    remedy,
  };
}

const isOpen = (id: string) => {
  const f = getFinding(id);
  return !!f && f.resolvedAt === null;
};

async function evaluate(m: Monitor, r: ProbeResult, at: number) {
  const flipCount = flips(m.id);
  const flapping = flipCount >= FLAP_FLIPS;
  if (r.ok) {
    if (isOpen(downId(m.id)) && trailingSuccesses(m.id) >= (flapping ? FLAP_RECOVER : 1)) {
      resolve(downId(m.id), `${m.name} is answering again`);
    }
  } else {
    const fails = trailingFailures(m.id);
    if (fails >= m.config.failAfter) {
      const existing = getFinding(downId(m.id));
      const since = existing && existing.resolvedAt === null ? Number((existing.detail as { since?: number } | null)?.since ?? at) : at - (fails - 1) * m.config.intervalSec * 1000;
      raise(await downFinding(m, r, since));
    }
  }
  if (flapping && !isOpen(downId(m.id))) {
    raise({
      id: flapId(m.id),
      kind: "monitor.flapping",
      severity: "attention",
      subject: m.config.app ?? null,
      title: `${m.name} keeps dropping out`,
      cause: "It has gone down and come back several times in the last hour. That usually means it's overloaded, restarting, or the network is unreliable.",
      detail: { monitorId: m.id, target: m.target },
      remedy: { action: "", label: "See the check history", href: `/alerts?tab=monitors&monitor=${encodeURIComponent(m.id)}` },
    });
  } else if (flipCount <= 1) {
    resolve(flapId(m.id));
  }
}

// ---------------------------------------------------------------- running checks

async function probe(m: Monitor): Promise<ProbeResult> {
  if (m.kind === "tcp") {
    const hp = parseHostPort(m.target);
    if (!hp) return { ok: false, latencyMs: null, status: null, error: "the address isn't valid" };
    return probeTcp(hp.host, hp.port, m.config.timeoutSec);
  }
  const r = await probeHttp(m.target, m.config);
  // Auto app monitors only ask "does the port answer?": some apps speak something other than HTTP.
  if (!r.ok && r.notHttp && isAppMonitor(m)) return { ...r, ok: true, error: null };
  return r;
}

export async function runCheck(m: Monitor): Promise<ProbeResult & { at: number }> {
  const st = runner();
  if (st.running.has(m.id)) throw conflict("A check is already running for this monitor.");
  st.running.add(m.id);
  try {
    const at = now();
    const r = await probe(m);
    const fresh = getMonitor(m.id);
    if (!fresh) return { ...r, at }; // removed while checking
    recordCheck(m.id, at, r);
    if (fresh.enabled) await evaluate(fresh, r, at);
    publish("monitors", { id: m.id, at, ok: r.ok });
    return { ...r, at };
  } finally {
    st.running.delete(m.id);
  }
}

function jitter(intervalMs: number) {
  const spread = Math.min(intervalMs * 0.1, 5000);
  return intervalMs + (Math.random() * 2 - 1) * spread;
}

let scheduling = false;
export async function schedule() {
  if (scheduling) return;
  scheduling = true;
  try {
    const st = runner();
    const t = now();
    const list = monitors();
    const known = new Set(list.map((m) => m.id));
    for (const id of st.next.keys()) if (!known.has(id)) st.next.delete(id);
    let apps: Map<string, AppSummary> | null = null;
    for (const m of list) {
      if (!m.enabled) {
        st.next.delete(m.id);
        continue;
      }
      const intervalMs = m.config.intervalSec * 1000;
      const due = st.next.get(m.id);
      if (due === undefined) {
        // First sight (startup or new monitor): spread the first checks over up to 20 s.
        st.next.set(m.id, t + Math.random() * Math.min(intervalMs, 20_000));
        continue;
      }
      if (due > t || st.running.has(m.id)) continue;
      if (st.running.size >= CONCURRENCY) break;
      st.next.set(m.id, t + jitter(intervalMs));

      if (isAppMonitor(m)) {
        if (!apps) {
          try {
            apps = new Map((await listApps()).map((a) => [a.id, a]));
          } catch {
            apps = new Map();
          }
        }
        const app = apps.get(m.ref!.slice(4));
        if (apps.size && (!app || app.line === "stopped" || app.line === "paused")) {
          if (!st.idle.has(m.id)) {
            st.idle.add(m.id);
            clearFindings(m.id);
          }
          continue;
        }
        st.idle.delete(m.id);
      }
      void runCheck(m).catch((e) => console.error(`[gluon] monitor ${m.name} failed to run`, e));
    }
  } finally {
    scheduling = false;
  }
}
