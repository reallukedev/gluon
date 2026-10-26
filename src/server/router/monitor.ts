import "server-only";
import { all, db, now, one, run } from "../db";
import { AppError } from "../errors";
import { systemEvent } from "../audit";
import { raise, resolve } from "../findings";
import type { DeviceT, RouterEventT, RouterGlance, RouterOverview, SectionKey } from "@/lib/router-types";
import { identify, withRouter, type Identity } from "./bgw-client";
import { readBroadband, readDevices, readFirewall, readOptical, readSysinfo, readWifi, sortDevices, type Sysinfo } from "./bgw-status";
import { buckets, compare, current, sameBoot, type Change, type Sample, type Seen } from "./traffic";
import { access, codeOnHold } from "./access";
import { whereAmI, type Here } from "./where";

/**
 * What the router says, read in the background and served from memory, so no page ever waits on
 * a router that takes 40 seconds per page. Reads are grouped by how fast the pages answer and how
 * fast they change, and they speed up only while someone has the router page open:
 *
 *   status   System Information + Broadband (about 2 s): every 15 s while watched, else every 2 min
 *   network  Status + Device List (about 10 s): every minute while watched, else every 30 min
 *   line     Fiber + Firewall: every 5 min while watched, else hourly
 *
 * The status reads also feed the throughput history (byte counters, kept 2 days) and notice
 * restarts and broadband drops. A failed read keeps the last good data and backs off.
 */

type Group = "status" | "network" | "line";
const GROUPS: Group[] = ["status", "network", "line"];
const EVERY: Record<Group, { watched: number; glanced: number; idle: number }> = {
  status: { watched: 15_000, glanced: 120_000, idle: 120_000 },
  network: { watched: 60_000, glanced: 10 * 60_000, idle: 30 * 60_000 },
  line: { watched: 5 * 60_000, glanced: 60 * 60_000, idle: 60 * 60_000 },
};
const SECTIONS: Record<Group, SectionKey[]> = { status: ["facts", "broadband"], network: ["wifi", "devices"], line: ["optical", "firewall"] };
/** Someone is "watching" for this long after their last look (pages poll more often than that). */
const WATCH_MS = 45_000;
const GLANCE_MS = 15 * 60_000;
const KEEP_SAMPLES_MS = 2 * 86_400_000;
const KEEP_EVENTS_MS = 60 * 86_400_000;
const RESTART_WAIT_MS = 8 * 60_000;
/** The traffic chart: six hours in two-minute steps (the idle reading cadence). */
const HISTORY_MS = 6 * 3_600_000;
const BUCKET_MS = 2 * 60_000;

interface State {
  gateway: string | null;
  identity: Identity | null;
  identifiedAt: number;
  sys: Sysinfo | null;
  broadband: RouterOverview["broadband"];
  optical: RouterOverview["optical"];
  firewall: RouterOverview["firewall"];
  wifi: RouterOverview["wifi"];
  /** Raw pages for the device list: who "this server" is can change without a new read. */
  devicesHtml: string | null;
  homeHtml: string | null;
  readAt: Partial<Record<SectionKey, number>>;
  lastTry: Partial<Record<Group, number>>;
  failures: Partial<Record<Group, number>>;
  error: string | null;
  /** When the router says its web sessions are all taken, every read waits until then. */
  pauseUntil: number;
  running: Promise<void> | null;
  watchedUntil: number;
  glancedAt: number;
  restart: (NonNullable<RouterOverview["restart"]> & { prevBoot: number | null }) | null;
}

type G = typeof globalThis & { __gluonRouterMonitor?: State; __gluonRouterTables?: boolean };
const g = globalThis as G;
const fresh = (gateway: string | null): State => ({
  gateway,
  identity: null,
  identifiedAt: 0,
  sys: null,
  broadband: null,
  optical: null,
  firewall: null,
  wifi: null,
  devicesHtml: null,
  homeHtml: null,
  readAt: {},
  lastTry: {},
  failures: {},
  error: null,
  pauseUntil: 0,
  running: null,
  watchedUntil: 0,
  glancedAt: 0,
  restart: null,
});
const st = () => (g.__gluonRouterMonitor ??= fresh(null));

function ensureTables() {
  if (g.__gluonRouterTables) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS router_samples (gateway TEXT NOT NULL, ts INTEGER NOT NULL, rx INTEGER NOT NULL, tx INTEGER NOT NULL, boot INTEGER, PRIMARY KEY (gateway, ts));
    CREATE TABLE IF NOT EXISTS router_seen (gateway TEXT PRIMARY KEY, seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS router_events (id INTEGER PRIMARY KEY AUTOINCREMENT, gateway TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS router_events_at ON router_events (gateway, at);
  `);
  g.__gluonRouterTables = true;
}

// ---------------------------------------------------------------- scheduling

function cadence(s: State, group: Group, t: number): number {
  const e = EVERY[group];
  return t < s.watchedUntil ? e.watched : t - s.glancedAt < GLANCE_MS ? e.glanced : e.idle;
}

/** A group is due when its data is older than its cadence, and a failure has had time to clear. */
function due(s: State, group: Group, t: number): boolean {
  const last = Math.min(...SECTIONS[group].map((k) => s.readAt[k] ?? 0));
  const fails = s.failures[group] ?? 0;
  const backoff = fails ? Math.min(10 * 60_000, 30_000 * 2 ** (fails - 1)) : 0;
  return t - last >= cadence(s, group, t) && t - (s.lastTry[group] ?? 0) >= Math.max(backoff, 5_000);
}

async function readGroup(s: State, gateway: string, group: Group) {
  const t0 = now();
  s.lastTry[group] = t0;
  try {
    await withRouter(gateway, null, async (r) => {
      if (group === "status") {
        const sysHtml = await r.read("sysinfo");
        const sysAt = now();
        const bbHtml = await r.read("broadbandstatistics");
        const bbAt = now();
        s.sys = readSysinfo(sysHtml, sysAt);
        s.broadband = readBroadband(bbHtml);
        s.readAt.facts = sysAt;
        s.readAt.broadband = bbAt;
        observe(s, gateway, bbAt);
      } else if (group === "network") {
        s.homeHtml = await r.read("home");
        s.wifi = readWifi(s.homeHtml);
        s.readAt.wifi = now();
        s.devicesHtml = await r.read("devices");
        s.readAt.devices = now();
      } else {
        s.optical = readOptical(await r.read("fiberstat"));
        s.readAt.optical = now();
        s.firewall = readFirewall(await r.read("firewall"));
        s.readAt.firewall = now();
      }
    });
    s.failures[group] = 0;
    s.error = null;
  } catch (e) {
    const fails = (s.failures[group] = (s.failures[group] ?? 0) + 1);
    s.error = e instanceof AppError ? e.message : "Gluon couldn't read your router.";
    // A full session pool is the router's, not the page's: leave it alone for a while.
    if (e instanceof AppError && e.code === "router_busy") s.pauseUntil = now() + Math.min(10 * 60_000, 60_000 * fails);
  }
}

/** One step of background work: find the router, then read whatever is due (one group at a time). */
export async function tick(): Promise<void> {
  const s0 = st();
  if (s0.running) return s0.running;
  const work = (async () => {
    const here = await whereAmI();
    let s = st();
    if (s.gateway !== here.gateway) {
      g.__gluonRouterMonitor = s = { ...fresh(here.gateway), watchedUntil: s.watchedUntil, glancedAt: s.glancedAt };
    }
    if (!here.gateway || s.restart?.state === "waiting" || now() < s.pauseUntil) return;
    const t = now();
    const idAge = t - s.identifiedAt;
    if (!s.identity || (s.identity.kind !== "bgw" && idAge > (s.identity.kind === "unreachable" ? 60_000 : 30 * 60_000)) || idAge > 6 * 3_600_000) {
      try {
        s.identity = await identify(here.gateway);
        s.error = s.identity.kind === "unreachable" ? `Your router at ${here.gateway} didn't answer.` : null;
      } catch (e) {
        s.error = e instanceof AppError ? e.message : "Gluon couldn't reach your router.";
        if (e instanceof AppError && e.code === "router_busy") s.pauseUntil = now() + 60_000;
      }
      s.identifiedAt = now();
    }
    if (s.identity?.kind !== "bgw") return;
    for (const group of GROUPS) {
      if (due(s, group, now())) {
        await readGroup(s, here.gateway, group);
        break;
      }
    }
  })().finally(() => {
    st().running = null;
  });
  st().running = work;
  return work;
}

// ---------------------------------------------------------------- history and changes

function observe(s: State, gateway: string, at: number) {
  ensureTables();
  const boot = s.sys?.bootAt ?? null;
  const bb = s.broadband;
  if (bb?.rxBytes != null && bb.txBytes != null) {
    run("INSERT OR REPLACE INTO router_samples (gateway, ts, rx, tx, boot) VALUES (?, ?, ?, ?, ?)", gateway, at, bb.rxBytes, bb.txBytes, boot);
  }
  const row = one<{ seen: string }>("SELECT seen FROM router_seen WHERE gateway = ?", gateway);
  const prev = row ? (JSON.parse(row.seen) as Seen) : null;
  const { seen, changes } = compare(prev, { at, boot, broadband: bb?.up ?? null });
  run("INSERT INTO router_seen (gateway, seen) VALUES (?, ?) ON CONFLICT(gateway) DO UPDATE SET seen = excluded.seen", gateway, JSON.stringify(seen));
  for (const c of changes) record(s, gateway, c);
  // Broadband that's down at the first look still counts once it's confirmed.
  if (seen.broadband === false) raiseDown(s, seen.since ?? at);
}

const span = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return m === 1 ? "a minute" : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "an hour" : `${h} hours`;
  const d = Math.round(h / 24);
  return `${d} days`;
};

function record(s: State, gateway: string, c: Change) {
  const model = s.identity?.kind === "bgw" ? s.identity.model.replace(/^HUMAX\s+/i, "") : "router";
  let text: string;
  if (c.kind === "restarted") {
    const asked = s.restart && Math.abs(s.restart.requestedAt - c.at) < RESTART_WAIT_MS;
    text = asked ? "Your router restarted when Gluon asked it to." : `Your router restarted${c.upFor ? ` after ${span(c.upFor)} up` : ""}.`;
  } else if (c.kind === "broadband-down") text = `Your ${model} lost its internet connection.`;
  else text = `Your internet connection came back${c.downFor ? ` after ${span(c.downFor)}` : ""}.`;
  run("INSERT INTO router_events (gateway, at, kind, text) VALUES (?, ?, ?, ?)", gateway, c.at, c.kind, text);
  systemEvent({ action: `router.${c.kind}`, target: gateway, summary: text, outcome: c.kind === "broadband-down" ? "failed" : "ok" });
  if (c.kind === "broadband-up") resolve("router.broadband", text);
}

function raiseDown(s: State, since: number) {
  const model = s.identity?.kind === "bgw" ? s.identity.model.replace(/^HUMAX\s+/i, "") : "router";
  const fiber = /fiber/i.test(s.broadband?.source ?? "");
  raise({
    id: "router.broadband",
    kind: "router.broadband",
    severity: "fault",
    subject: "internet",
    title: "Your internet connection is down",
    cause: `Your ${model} says its ${fiber ? "fiber " : ""}connection to AT&T is down, so nothing outside your home can reach this server, and apps that need the internet can't reach it either. Gluon sends this when it can and says when it's back. It often clears on its own within minutes; if it doesn't, check the router's lights${fiber ? " and the fiber cable" : ""}, then call AT&T.`,
    detail: { since },
    remedy: { action: "", label: "See what the router says", href: "/network/router" },
  });
}

export function pruneRouter() {
  ensureTables();
  run("DELETE FROM router_samples WHERE ts < ?", now() - KEEP_SAMPLES_MS);
  run("DELETE FROM router_events WHERE at < ?", now() - KEEP_EVENTS_MS);
}

function samples(gateway: string, since: number): Sample[] {
  ensureTables();
  return all<{ ts: number; rx: number; tx: number; boot: number | null }>("SELECT ts, rx, tx, boot FROM router_samples WHERE gateway = ? AND ts >= ? ORDER BY ts", gateway, since).map((r) => ({ t: r.ts, rx: r.rx, tx: r.tx, boot: r.boot }));
}

function events(gateway: string): RouterEventT[] {
  ensureTables();
  return all<RouterEventT>("SELECT at, kind, text FROM router_events WHERE gateway = ? AND at >= ? ORDER BY at DESC LIMIT 20", gateway, now() - 30 * 86_400_000);
}

// ---------------------------------------------------------------- restarts Gluon asked for

/**
 * After Gluon presses Restart: wait for the router to answer again and check it really did start
 * over (its uptime is shorter than the time since the press). Runs in the background.
 */
export function awaitRestart(gateway: string, requestedAt: number) {
  const s = st();
  s.restart = { requestedAt, state: "waiting", message: null, prevBoot: s.sys?.bootAt ?? null };
  void (async () => {
    // Until it goes down it still answers with its old uptime, which only counts as "not yet".
    let pause = 5_000;
    while (now() - requestedAt < RESTART_WAIT_MS) {
      try {
        const html = await withRouter(gateway, null, (r) => r.read("sysinfo", 10_000));
        const sys = readSysinfo(html, now());
        if (sys.bootAt !== null && !sameBoot(sys.bootAt, s.restart?.prevBoot ?? null) && sys.bootAt > requestedAt - 60_000) {
          s.sys = sys;
          s.readAt.facts = now();
          s.restart = { requestedAt, state: "done", message: `It answered again after ${span(now() - requestedAt)}.`, prevBoot: null };
          s.readAt = { facts: s.readAt.facts };
          return;
        }
        if (now() - requestedAt > 3 * 60_000) {
          s.restart = { requestedAt, state: "failed", message: "The router is still answering with its old uptime, so it didn't restart. Try again, or use the button on the router.", prevBoot: null };
          return;
        }
      } catch {
        /* still down: keep waiting */
      }
      await new Promise((r) => setTimeout(r, pause));
      pause = 15_000;
    }
    s.restart = { requestedAt, state: "failed", message: "The router hasn't answered for 8 minutes. Check that its lights are on; if they're off, unplug it for 10 seconds and plug it back in.", prevBoot: null };
  })();
}

// ---------------------------------------------------------------- reading it back

function devicesFor(s: State, here: Here): DeviceT[] | null {
  if (!s.devicesHtml) return null;
  return sortDevices(readDevices(s.devicesHtml, s.homeHtml, s.sys?.offset ?? null, { mac: here.mac, ip: here.lanIp }));
}

const otherName = (id: Identity | null) => (id?.kind === "other" ? id.name : null);

/**
 * The router page's data. Never waits on the router unless there is nothing at all yet, and then
 * only up to `waitMs` (the status pages take about two seconds).
 */
export async function overview(opts: { waitMs?: number; watch?: boolean } = {}): Promise<RouterOverview> {
  const here = await whereAmI();
  const s0 = st();
  if (opts.watch !== false) s0.watchedUntil = now() + WATCH_MS;
  void tick();
  if (opts.waitMs) {
    const deadline = now() + opts.waitMs;
    // Identifying the router, then the first status read: two ticks.
    for (let i = 0; i < 3 && !st().readAt.broadband && (!st().identity || st().identity?.kind === "bgw") && now() < deadline; i++) {
      await Promise.race([tick(), new Promise((r) => setTimeout(r, Math.max(0, deadline - now())))]);
    }
  }
  const s = st();
  const gw = here.gateway;
  const kind: RouterOverview["kind"] = !gw ? "none" : s.identity?.kind === "bgw" ? "bgw" : s.identity?.kind === "other" ? "other" : s.identity?.kind === "unreachable" ? "unreachable" : "bgw";
  const t = now();
  const series = gw && kind === "bgw" ? samples(gw, t - HISTORY_MS - BUCKET_MS) : [];
  const a = gw ? access(gw) : null;
  const { prevBoot: _drop, ...restart } = s.restart ?? { prevBoot: null };
  return {
    gateway: gw,
    kind,
    otherName: otherName(s.identity),
    facts: s.sys ? { manufacturer: s.sys.manufacturer, model: s.sys.model, serial: s.sys.serial, firmware: s.sys.firmware, hardware: s.sys.hardware, wanMac: s.sys.wanMac, firstUse: s.sys.firstUse, bootAt: s.sys.bootAt } : null,
    broadband: s.broadband,
    optical: s.optical,
    wifi: s.wifi,
    devices: devicesFor(s, here),
    firewall: s.firewall,
    readAt: s.readAt,
    refreshing: !!s.running,
    error: s.error,
    traffic: { points: buckets(series, Math.floor((t - HISTORY_MS) / BUCKET_MS) * BUCKET_MS, Math.floor(t / BUCKET_MS) * BUCKET_MS + BUCKET_MS, BUCKET_MS), rxTotal: s.broadband?.rxBytes ?? null, txTotal: s.broadband?.txBytes ?? null, now: current(series, t) },
    events: gw ? events(gw) : [],
    access: { connected: !!a, canRestart: !!a && kind === "bgw" && !(a && codeOnHold(a)), codeRejected: !!a && codeOnHold(a), connectedBy: a ? { name: a.by, at: a.at } : null },
    restart: s.restart ? (restart as RouterOverview["restart"]) : null,
    server: { ip: here.lanIp, mac: here.mac, name: here.hostname },
  };
}

/** The Home widget's slice: cheap, from memory, and it keeps the slow reads ticking over. */
export async function glance(): Promise<RouterGlance | null> {
  const here = await whereAmI();
  const s = st();
  s.glancedAt = now();
  void tick();
  if (!here.gateway || s.identity?.kind !== "bgw") return null;
  const devices = devicesFor(s, here);
  const series = samples(here.gateway, now() - 15 * 60_000);
  return {
    model: s.sys?.model ?? s.identity.model,
    broadband: s.broadband?.up ?? null,
    online: devices ? devices.filter((d) => d.online).length : null,
    now: current(series, now()),
    bootAt: s.sys?.bootAt ?? null,
    readAt: s.readAt.broadband ?? null,
  };
}

/**
 * What the router last said about its own internet connection, from memory and without waiting:
 * the Internet widget uses it to tell "the line is down" from "something else is wrong".
 */
export function routerSays(): { model: string | null; broadband: boolean | null; source: string | null; bootAt: number | null; readAt: number } | null {
  const s = st();
  if (s.identity?.kind !== "bgw" || !s.broadband || !s.readAt.broadband) return null;
  return { model: s.sys?.model ?? s.identity.model, broadband: s.broadband.up, source: s.broadband.source, bootAt: s.sys?.bootAt ?? null, readAt: s.readAt.broadband };
}

/** The monitor's recent answer to "what router is this?", so other reads needn't ask the router again. */
export function knownIdentity(gateway: string): Identity | null {
  const s = st();
  return s.gateway === gateway && s.identity && now() - s.identifiedAt < 10 * 60_000 ? s.identity : null;
}
