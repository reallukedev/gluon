import "server-only";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { docker } from "../docker/client";
import { tailLogs } from "../docker/logs";
import { listApps } from "../docker/apps";
import { hostPath } from "../host/paths";
import { all, db, now, one, run } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { User } from "../auth/users";
import { tryReadConfig } from "../caddy/routes";
import { LOCAL_HOST, lookupPublicIpv4, resolveName } from "../network/probes";
import { hostGlobalIpv6 } from "../network/status";
import { ddnsStatus } from "../network/ddns";
import type { DnsResult } from "@/lib/network-types";
import { JAVA_NEED_KEY, portNeedKey, type CraftyInfo, type GamePort, type GamesStatus, type McChangeResult, type McHistoryEntry, type McPing, type McRoute, type McRouterInfo, type McTarget } from "@/lib/games-types";
import { dnsNames, hostPathFor, isCrafty, isMcRouter, listContainers, nameOf, networkAliases, networksOf, parseMappingEnv, routerSettings, type Listed } from "./discover";
import { readCrafty, type CraftyRead } from "./crafty";
import { applyEdit, backendHost, backendPort, EditError, emptyDoc, normalizeHost, parseBackend, parseRoutes, restorable, serialize, writeInPlace, type Edit, type RoutesDoc } from "./routes-file";
import { slpPing } from "./ping";
import { hostDns, routeVerdict } from "./verdict";
import { clash, deleteGamePort, getGamePort, insertGamePort, listGamePorts, reservedPorts, updateGamePort, type GamePortInput, type GamePortRow } from "./ports";
import { portNeeds } from "../router/service";

/**
 * Network → Game servers. Minecraft Java addresses live in mc-router's routes file, which Gluon
 * edits in place and then tells mc-router to reload (SIGHUP: a full reload, so removed addresses
 * really go, without dropping anyone who's playing). Every change is checked by pinging the
 * address through mc-router, the way a player's server list does.
 */

type Where = { ip: string; zone: string };

// ------------------------------------------------------------------ what's there

interface Router {
  c: Listed;
  info: Docker.ContainerInspectInfo;
  settings: ReturnType<typeof routerSettings>;
  /** The routes file on this server (unmapped), when it's in a mounted folder. */
  file: string | null;
  hostPort: number | null;
  networks: string[];
}

interface Ctx {
  list: Listed[];
  aliases: Map<string, string[]>;
  router: Router | null;
  info: McRouterInfo;
  doc: RoutesDoc | null;
  /** Addresses mc-router has, whether from the file or (read-only) from MAPPING. */
  mappings: [string, string][];
  fallback: string | null;
  crafty: { c: Listed; read: CraftyRead } | null;
  craftyInfo: CraftyInfo;
}

const MAX_FILE = 1024 * 1024;

async function findRouter(list: Listed[]): Promise<Router | null> {
  const c = list.filter(isMcRouter).sort((a, b) => Number(b.State === "running") - Number(a.State === "running"))[0];
  if (!c) return null;
  const info = await docker().getContainer(c.Id).inspect();
  const settings = routerSettings(info.Config.Env ?? [], [...((info.Config.Entrypoint as string[] | null) ?? []), ...(info.Config.Cmd ?? [])]);
  const inner = settings.routesConfig ? path.posix.resolve(info.Config.WorkingDir || "/", settings.routesConfig) : null;
  const file = inner ? hostPathFor(info.Mounts ?? [], inner) : null;
  const bind = info.NetworkSettings?.Ports?.[`${settings.port}/tcp`]?.find((b) => b.HostPort);
  const hostMode = info.HostConfig?.NetworkMode === "host";
  return { c, info, settings, file, hostPort: hostMode ? settings.port : bind ? Number(bind.HostPort) : null, networks: Object.keys(info.NetworkSettings?.Networks ?? {}) };
}

function readFile(file: string): { raw: string | null; error: string | null } {
  try {
    const p = hostPath(file);
    if (fs.statSync(p).size > MAX_FILE) return { raw: null, error: "It's over 1 MB, which isn't a routes file." };
    return { raw: fs.readFileSync(p, "utf8"), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: null, error: null };
    return { raw: null, error: code === "EACCES" ? "No permission to read it." : `Couldn't read it (${code ?? "error"}).` };
  }
}

function writable(file: string): boolean {
  try {
    fs.accessSync(hostPath(file), fs.constants.W_OK);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      fs.accessSync(hostPath(path.posix.dirname(file)), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

const versionOf = (c: Listed, info: Docker.ContainerInspectInfo) => info.Config.Labels?.["org.opencontainers.image.version"] ?? (c.Image.includes(":") ? c.Image.slice(c.Image.lastIndexOf(":") + 1) : null);

/** Of several Crafty containers, the one mc-router sends players to. */
function pickCrafty(list: Listed[], aliases: Map<string, string[]>, router: Router | null, mappings: [string, string][]): Listed | null {
  const all = list.filter(isCrafty);
  if (all.length <= 1) return all[0] ?? null;
  const hosts = new Set(mappings.map(([, b]) => backendHost(b)));
  const score = (c: Listed) =>
    (dnsNames(c, aliases).some((n) => hosts.has(n)) ? 8 : 0) + (router && networksOf(c).some((n) => router.networks.includes(n)) ? 4 : 0) + (c.State === "running" ? 2 : 0) + (nameOf(c) === "crafty_container" ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a))[0]!;
}

async function load(): Promise<Ctx> {
  const list = await listContainers();
  const router = await findRouter(list);
  const info: McRouterInfo = { status: "missing", container: null, version: null, file: null, editable: false, reason: null, watch: false, hostPort: null, networks: [], broken: null, rev: null };
  let doc: RoutesDoc | null = null;
  let mappings: [string, string][] = [];
  let fallback: string | null = null;
  if (router) {
    Object.assign(info, { status: router.c.State === "running" ? "running" : "stopped", container: nameOf(router.c), version: versionOf(router.c, router.info), file: router.file, watch: router.settings.watch, hostPort: router.hostPort, networks: router.networks });
    const envMappings = router.settings.mapping ? parseMappingEnv(router.settings.mapping) : [];
    fallback = router.settings.fallback;
    if (!router.settings.routesConfig) {
      mappings = envMappings;
      info.reason = "mc-router takes its addresses from its compose file (MAPPING), not a routes file, so Gluon can show them but not change them. Set ROUTES_CONFIG to let Gluon manage them.";
    } else if (!router.file) {
      info.reason = `mc-router's routes file (${router.settings.routesConfig}) is inside its container, not in a folder on this server, so Gluon can't change it. Mount its folder from the server.`;
    } else {
      const { raw, error } = readFile(router.file);
      if (error) {
        info.reason = `Can't open ${router.file}: ${error}`;
      } else {
        const parsed: ReturnType<typeof parseRoutes> = raw === null ? { ok: true, doc: emptyDoc() } : parseRoutes(raw);
        if (!parsed.ok) {
          info.broken = { message: parsed.message, line: parsed.line, excerpt: parsed.excerpt };
          info.reason = "Gluon won't change the routes file until it can read it.";
        } else {
          doc = parsed.doc;
          info.rev = raw === null ? "new" : doc.rev;
          mappings = [...envMappings.filter(([h]) => !doc!.mappings.some(([k]) => k.toLowerCase() === h.toLowerCase())), ...doc.mappings];
          fallback = doc.fallback ?? fallback;
          if (!writable(router.file)) info.reason = `Gluon isn't allowed to change ${router.file}.`;
          else info.editable = true;
        }
      }
    }
  }
  const aliases = await networkAliases(list, router?.networks ?? []);
  const cc = pickCrafty(list, aliases, router, mappings);
  const read = cc ? await readCrafty(cc).catch(() => ({ servers: [], names: false, live: false })) : null;
  const craftyInfo: CraftyInfo = cc && read ? { status: cc.State === "running" ? "running" : "stopped", container: nameOf(cc), servers: read.servers, names: read.names, live: read.live } : { status: "missing", container: null, servers: [], names: false, live: false };
  return { list, aliases, router, info, doc, mappings, fallback, crafty: cc && read ? { c: cc, read } : null, craftyInfo };
}

function targetOf(ctx: Ctx, backend: string): McTarget {
  const host = backendHost(backend);
  const port = backendPort(backend);
  if (ctx.crafty && port && dnsNames(ctx.crafty.c, ctx.aliases).includes(host)) {
    return { kind: "crafty", port, servers: ctx.crafty.read.servers.filter((s) => s.port === port && s.type !== "minecraft-bedrock") };
  }
  const c = ctx.list.find((x) => dnsNames(x, ctx.aliases).includes(host));
  if (c) return { kind: "container", name: nameOf(c), running: c.State === "running", sharesNetwork: !!ctx.router && networksOf(c).some((n) => ctx.router!.networks.includes(n)) };
  return { kind: "address" };
}

// ------------------------------------------------------------------ checks

interface Checks {
  at: number;
  pings: Map<string, McPing>;
  dns: Map<string, DnsResult | null>;
  publicIp: { v4: string | null; v6: string[] };
}

type G = typeof globalThis & { __gluonGameChecks?: Checks; __gluonGameChecking?: Promise<Checks> | null; __gluonGameLock?: Promise<unknown>; __gluonJavaNeed?: { at: number; v: Promise<{ hostPort: number; addresses: number } | null> } };
const g = globalThis as G;
const CHECK_TTL = 90_000;
/** What a player gets when they type an address mc-router doesn't know. */
const UNKNOWN_HOST = "gluon-check.invalid";

async function publicIp() {
  const ddns = await ddnsStatus().catch(() => null);
  const v4 = ddns?.ipv4?.address ?? (await lookupPublicIpv4());
  return { v4, v6: [...new Set([...(ddns?.ipv6?.addresses ?? []), ...hostGlobalIpv6()])] };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

/** Where Gluon reaches mc-router's player port. */
function routerAddress(r: Router): { host: string; port: number } | null {
  if (r.hostPort) return { host: LOCAL_HOST, port: r.hostPort };
  const ip = Object.values(r.info.NetworkSettings?.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress;
  return ip ? { host: ip, port: r.settings.port } : null;
}

async function pingThroughRouter(r: Router | null, host: string): Promise<McPing | null> {
  if (!r || r.c.State !== "running") return null;
  const at = routerAddress(r);
  return at ? slpPing(at.host, at.port, host, 5000) : null;
}

async function checks(ctx: Ctx, force: boolean, ports: GamePortRow[]): Promise<Checks> {
  const hosts = ctx.mappings.map(([h]) => h.toLowerCase());
  const addrs = ports.map((p) => p.address).filter((a): a is string => !!a);
  const prev = g.__gluonGameChecks;
  const covered = prev && [...hosts, ...(ctx.fallback ? [UNKNOWN_HOST] : [])].every((h) => prev.pings.has(h) || ctx.info.status !== "running") && [...hosts, ...addrs].every((h) => prev.dns.has(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h));
  if (!force && prev && covered && Date.now() - prev.at < CHECK_TTL) return prev;
  // Several tabs refreshing at once share one round of pings.
  if (!force && g.__gluonGameChecking) return g.__gluonGameChecking;
  const run = runChecks(ctx, hosts, addrs).finally(() => {
    if (g.__gluonGameChecking === run) g.__gluonGameChecking = null;
  });
  g.__gluonGameChecking = run;
  return run;
}

async function runChecks(ctx: Ctx, hosts: string[], addrs: string[]): Promise<Checks> {
  const ip = await publicIp();
  const pingHosts = ctx.info.status === "running" ? [...hosts, ...(ctx.fallback ? [UNKNOWN_HOST] : [])] : [];
  const dnsHosts = [...new Set([...hosts, ...addrs])].filter((h) => !/^\d+\.\d+\.\d+\.\d+$/.test(h));
  const [pings, dns] = await Promise.all([
    // mc-router lets a few connections a second in; keep well under that.
    mapLimit(pingHosts, 2, async (h) => [h, await pingThroughRouter(ctx.router, h)] as const),
    mapLimit(dnsHosts, 4, async (h) => [h, await resolveName(h, ip).catch(() => null)] as const),
  ]);
  const out: Checks = { at: Date.now(), pings: new Map(pings.filter((p): p is [string, McPing] => !!p[1])), dns: new Map(dns), publicIp: ip };
  g.__gluonGameChecks = out;
  return out;
}

/** The domain new addresses go under: the parent most existing addresses share, else the base domain. */
export function guessDomain(hosts: string[], base: string | null): string | null {
  const counts = new Map<string, number>();
  const names = hosts.map((h) => h.toLowerCase()).filter((h) => !/^\d+\.\d+\.\d+\.\d+$/.test(h) && h.split(".").length >= 3);
  for (const h of names) {
    const parent = h.slice(h.indexOf(".") + 1);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best?.[0] ?? base;
}

function publisher(apps: Awaited<ReturnType<typeof listApps>>, p: GamePortRow): GamePort["publishedBy"] {
  for (const a of apps)
    for (const c of a.containers) {
      const hit = c.ports.find((x) => x.host >= p.hostMin && x.host <= p.hostMax && (p.protocol === "both" || x.proto === p.protocol));
      if (hit) return { container: c.name, app: a.name !== c.name ? a.name : null, running: c.state === "running" };
    }
  return null;
}

export async function gamesStatus(opts: { force?: boolean } = {}): Promise<GamesStatus> {
  const ctx = await load();
  const rows = listGamePorts();
  const [ck, apps] = await Promise.all([checks(ctx, !!opts.force, rows), listApps().catch(() => [])]);
  const known = !!ck.publicIp.v4 || ck.publicIp.v6.length > 0;
  const routes: McRoute[] = ctx.mappings.map(([host, backend]) => {
    const target = targetOf(ctx, backend);
    const ping = ck.pings.get(host.toLowerCase()) ?? null;
    return { host, backend, target, ping, dns: hostDns(host, ck.dns.get(host.toLowerCase()) ?? null, known), ...routeVerdict(ping, target, ctx.info.status, backend) };
  });
  const fallback = ctx.fallback
    ? (() => {
        const target = targetOf(ctx, ctx.fallback!);
        const ping = ck.pings.get(UNKNOWN_HOST) ?? null;
        return { backend: ctx.fallback!, target, ping, ...routeVerdict(ping, target, ctx.info.status, ctx.fallback!) };
      })()
    : null;
  const ports: GamePort[] = rows.map((p) => ({ ...p, needKey: portNeedKey(p.id), publishedBy: publisher(apps, p), dns: p.address ? hostDns(p.address, ck.dns.get(p.address) ?? null, known) : null }));
  return {
    mcRouter: ctx.info,
    crafty: ctx.craftyInfo,
    routes,
    fallback,
    domain: guessDomain(ctx.mappings.map(([h]) => h), tryReadConfig()?.base_domain ?? null),
    publicIp: ck.publicIp,
    javaNeedKey: JAVA_NEED_KEY,
    ports,
    checkedAt: ck.at,
  };
}

/** For the router's port forwarding: mc-router's player port, when it has somewhere to send players. */
export function javaNeed(): Promise<{ hostPort: number; addresses: number } | null> {
  const c = g.__gluonJavaNeed;
  if (c && Date.now() - c.at < 15_000) return c.v;
  const v = (async () => {
    const list = await listContainers();
    const r = await findRouter(list);
    if (!r) return null;
    let addresses = r.settings.mapping ? parseMappingEnv(r.settings.mapping).length : 0;
    let fallback = !!r.settings.fallback;
    if (r.file) {
      const { raw } = readFile(r.file);
      const p = raw === null ? null : parseRoutes(raw);
      // A file Gluon can't read still has addresses mc-router loaded before it broke.
      if (p && !p.ok) return { hostPort: r.hostPort ?? 25565, addresses: 1 };
      if (p?.ok) {
        addresses += p.doc.mappings.length;
        fallback ||= !!p.doc.fallback;
      }
    }
    return addresses || fallback ? { hostPort: r.hostPort ?? 25565, addresses } : null;
  })();
  g.__gluonJavaNeed = { at: Date.now(), v };
  return v;
}

// ------------------------------------------------------------------ history

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mc_router_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  file TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  username TEXT
);`;
type GS = typeof globalThis & { __gluonMcHistorySchema?: boolean };
function ensure() {
  const gs = globalThis as GS;
  if (gs.__gluonMcHistorySchema) return;
  db().exec(SCHEMA);
  gs.__gluonMcHistorySchema = true;
}

const KEEP = 40;

/** Keep the file as it was before a change, so it can be put back. */
function snapshot(file: string, content: string, summary: string, user: Pick<User, "username">): number {
  ensure();
  const id = Number(run("INSERT INTO mc_router_history (at, file, content, summary, username) VALUES (?, ?, ?, ?, ?)", now(), file, content, summary, user.username).lastInsertRowid);
  run("DELETE FROM mc_router_history WHERE file = ? AND id NOT IN (SELECT id FROM mc_router_history WHERE file = ? ORDER BY id DESC LIMIT ?)", file, file, KEEP);
  return id;
}

export async function mcHistory(): Promise<McHistoryEntry[]> {
  const ctx = await load();
  if (!ctx.info.file) return [];
  ensure();
  return all<{ id: number; at: number; content: string; summary: string; username: string | null }>("SELECT id, at, content, summary, username FROM mc_router_history WHERE file = ? ORDER BY id DESC", ctx.info.file).map((r) => {
    const p = parseRoutes(r.content);
    return { id: r.id, at: r.at, summary: r.summary, username: r.username, mappings: p.ok ? p.doc.mappings.length : 0 };
  });
}

// ------------------------------------------------------------------ changes

/** One change at a time, so two people (or tabs) can't interleave edits to the file. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__gluonGameLock ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  g.__gluonGameLock = next.catch(() => undefined);
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tell mc-router to read the file again. SIGHUP makes it reset and load the file (the watcher
 * only adds and updates, so a removed address would keep working until a restart). Its log says
 * whether it did. With MAPPING set too, a reset would drop those, so the watcher is left to it.
 */
async function reload(r: Router | null): Promise<{ applied: boolean; note: string | null }> {
  if (!r || r.c.State !== "running") return { applied: false, note: "mc-router isn't running. It reads the change when it starts." };
  if (r.settings.mapping) return { applied: r.settings.watch, note: r.settings.watch ? "Removed addresses keep working until mc-router restarts, because it also has addresses in MAPPING." : "Restart mc-router to use the change." };
  const t = Date.now();
  try {
    await docker().getContainer(r.c.Id).kill({ signal: "SIGHUP" });
  } catch (e) {
    return { applied: false, note: `Couldn't signal mc-router (${e instanceof Error ? e.message : "error"}). Restart it to use the change.` };
  }
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 150 : 300);
    const lines = await tailLogs(r.c.Id, nameOf(r.c), { since: t - 2000, tail: 200 }).catch(() => []);
    const after = lines.filter((l) => l.t >= t - 1500);
    if (after.some((l) => /Could not re-read the routes config file/i.test(l.text))) return { applied: false, note: "mc-router couldn't read the new file. Its log has the details." };
    if (after.some((l) => /Re-loading routes config file/i.test(l.text))) return { applied: true, note: null };
  }
  return { applied: false, note: "mc-router didn't say it reloaded. Restart it if the change doesn't show up." };
}

function needWritable(ctx: Ctx): { r: Router; file: string; doc: RoutesDoc } {
  if (ctx.info.status === "missing" || !ctx.router) throw new AppError("no_mc_router", "mc-router isn't installed on this server.", 409);
  if (!ctx.info.editable || !ctx.doc || !ctx.info.file) throw new AppError("routes_locked", ctx.info.reason ?? "Can't change mc-router's routes file.", 409);
  return { r: ctx.router, file: ctx.info.file, doc: ctx.doc };
}

/** Write a new version of the file and make sure that's what's there now. */
function put(file: string, content: string) {
  writeInPlace(hostPath(file), content);
  const back = fs.readFileSync(hostPath(file), "utf8");
  if (back !== content) throw new AppError("write_failed", `${file} didn't keep the change. Gluon's earlier copy is in the history.`, 500);
}

function describe(ctx: Ctx, backend: string): string {
  const t = targetOf(ctx, backend);
  if (t.kind === "crafty" && t.servers.length === 1) return `${t.servers[0]!.name} (${backend})`;
  return backend;
}

async function change(user: User, where: Where, rev: string, edit: Edit, verb: (ctx: Ctx) => { summary: string; checkHost: string | null; action: string; target: string }): Promise<McChangeResult> {
  return locked(async () => {
    const ctx = await load();
    const { r, file, doc } = needWritable(ctx);
    if (rev !== ctx.info.rev) throw new AppError("routes_changed", "mc-router's routes file changed since this page loaded, probably by hand. Gluon has the new version now: check it and try again.", 409);
    let data: Record<string, unknown>;
    try {
      data = applyEdit(doc, edit);
    } catch (e) {
      if (e instanceof EditError) throw new AppError("invalid", e.message, 400, e.field ? { field: e.field } : undefined);
      throw e;
    }
    const v = verb(ctx);
    const undo = snapshot(file, doc.raw, v.summary, user);
    put(file, serialize(data, doc.indent));
    g.__gluonJavaNeed = undefined;
    const res = await reload(r);
    audit(user, { action: v.action, target: v.target, summary: v.summary, detail: { file, applied: res.applied, note: res.note } }, where);
    const ping = v.checkHost && res.applied ? await pingThroughRouter(r, v.checkHost) : null;
    const status = await gamesStatus({ force: true });
    return { status, check: v.checkHost ? { host: v.checkHost, ping } : null, applied: res.applied, undo, note: res.note };
  });
}

function cleanHost(input: string): string {
  const h = normalizeHost(input);
  if (!h.ok) throw new AppError("invalid", h.message, 400, { field: "host" });
  return h.host;
}

function cleanBackend(input: string): string {
  const b = parseBackend(input);
  if (!b.ok) throw new AppError("invalid", b.message, 400, { field: "backend" });
  return b.value;
}

export function addMapping(user: User, where: Where, body: { host: string; backend: string; rev: string }) {
  const host = cleanHost(body.host);
  const backend = cleanBackend(body.backend);
  return change(user, where, body.rev, { kind: "add", host, backend }, (ctx) => ({ summary: `Minecraft: added ${host}, reaching ${describe(ctx, backend)}`, checkHost: host, action: "games.mc.add", target: host }));
}

export function updateMapping(user: User, where: Where, body: { host: string; rename?: string | null; backend?: string | null; rev: string }) {
  const rename = body.rename ? cleanHost(body.rename) : undefined;
  const backend = body.backend ? cleanBackend(body.backend) : undefined;
  const host = body.host.trim();
  return change(user, where, body.rev, { kind: "update", host, rename, backend }, (ctx) => {
    const old = ctx.mappings.find(([h]) => h.toLowerCase() === host.toLowerCase());
    const parts = [rename && rename !== host.toLowerCase() ? `renamed ${host} to ${rename}` : null, backend && backend !== old?.[1] ? `pointed ${rename ?? host} at ${describe(ctx, backend)}` : null].filter(Boolean);
    return { summary: `Minecraft: ${parts.join(", and ") || `saved ${host} unchanged`}`, checkHost: rename ?? host, action: "games.mc.update", target: rename ?? host };
  });
}

export function removeMapping(user: User, where: Where, body: { host: string; rev: string }) {
  const host = body.host.trim();
  return change(user, where, body.rev, { kind: "remove", host }, () => ({ summary: `Minecraft: removed ${host}`, checkHost: null, action: "games.mc.remove", target: host }));
}

export function setFallback(user: User, where: Where, body: { backend: string | null; rev: string }) {
  const backend = body.backend ? cleanBackend(body.backend) : null;
  return change(user, where, body.rev, { kind: "default", backend }, (ctx) => ({
    summary: backend ? `Minecraft: sent other addresses to ${describe(ctx, backend)}` : "Minecraft: turned other addresses away",
    checkHost: backend ? UNKNOWN_HOST : null,
    action: "games.mc.default",
    target: backend ?? "none",
  }));
}

/** Put back the file as it was before a change. The current file goes into the history first, so this can be undone too. */
export function restoreMcHistory(user: User, where: Where, id: number): Promise<McChangeResult> {
  return locked(async () => {
    const ctx = await load();
    if (!ctx.router || !ctx.info.file) throw new AppError("no_mc_router", "mc-router's routes file isn't on this server.", 409);
    if (!ctx.doc && !ctx.info.broken) throw new AppError("routes_locked", ctx.info.reason ?? "Can't change mc-router's routes file.", 409);
    if (!writable(ctx.info.file)) throw new AppError("routes_locked", `Gluon isn't allowed to change ${ctx.info.file}.`, 409);
    ensure();
    const row = one<{ at: number; content: string; summary: string }>("SELECT at, content, summary FROM mc_router_history WHERE id = ? AND file = ?", id, ctx.info.file);
    if (!row) throw new AppError("not_found", "That earlier version isn't kept any more.", 404);
    const content = restorable(row.content);
    if (!content) throw new AppError("invalid", "That earlier version can't be read either.", 409);
    const current = readFile(ctx.info.file).raw ?? "";
    const when = new Date(row.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const undo = snapshot(ctx.info.file, current, `Minecraft: put back the file from ${when}`, user);
    put(ctx.info.file, content);
    g.__gluonJavaNeed = undefined;
    const res = await reload(ctx.router);
    audit(user, { action: "games.mc.restore", target: ctx.info.file, summary: `Minecraft: put back mc-router's routes from ${when}`, detail: { id, applied: res.applied } }, where);
    return { status: await gamesStatus({ force: true }), check: null, applied: res.applied, undo, note: res.note };
  });
}

/** Ask mc-router to reload without changing anything (after a hand edit, say). */
export async function reloadMcRouter(user: User, where: Where): Promise<McChangeResult> {
  const ctx = await load();
  if (!ctx.router) throw new AppError("no_mc_router", "mc-router isn't installed on this server.", 409);
  const res = await reload(ctx.router);
  audit(user, { action: "games.mc.reload", target: ctx.info.container, summary: "Minecraft: asked mc-router to reload its routes", detail: { applied: res.applied } }, where);
  return { status: await gamesStatus({ force: true }), check: null, applied: res.applied, undo: null, note: res.note };
}

// ------------------------------------------------------------------ game ports

export interface GamePortBody {
  name: string;
  game?: string | null;
  protocol: "tcp" | "udp" | "both";
  ports: string;
  publicPort?: number | null;
  address?: string | null;
}

function portsInput(b: GamePortBody): GamePortInput {
  const m = b.ports.trim().match(/^(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?$/);
  if (!m) throw new AppError("invalid", "Enter a port like 19132, or a range like 2456-2457.", 400, { field: "ports" });
  const min = Number(m[1]);
  const max = Number(m[2] ?? m[1]);
  if (min < 1 || max > 65535 || max < min) throw new AppError("invalid", "Ports go from 1 to 65535, the smaller one first.", 400, { field: "ports" });
  if (max - min > 99) throw new AppError("invalid", "That's more than 100 ports. Games need a few at most.", 400, { field: "ports" });
  const pub = b.publicPort ?? min;
  if (pub < 1 || pub + (max - min) > 65535) throw new AppError("invalid", "The public ports don't fit under 65535.", 400, { field: "publicPort" });
  let address: string | null = null;
  if (b.address?.trim()) {
    const h = normalizeHost(b.address.replace(/:\d+$/, ""));
    if (!h.ok) throw new AppError("invalid", h.message.replace("players will type", "players type"), 400, { field: "address" });
    address = h.host;
  }
  const name = b.name.trim().replace(/\s+/g, " ");
  if (!name) throw new AppError("invalid", "Give it a name, like Valheim.", 400, { field: "name" });
  return { name, game: b.game ?? null, protocol: b.protocol, hostMin: min, hostMax: max, publicMin: pub, address };
}

/** Public ports the rest of Gluon forwards (web, chat, voice, calls, mc-router), which a game port mustn't take. */
async function reserved() {
  return reservedPorts(await portNeeds().catch(() => []));
}

const portText = (p: GamePortInput) => `${p.protocol === "both" ? "TCP/UDP" : p.protocol.toUpperCase()} ${p.hostMin === p.hostMax ? p.hostMin : `${p.hostMin}-${p.hostMax}`}`;

export async function addGamePort(user: User, where: Where, body: GamePortBody): Promise<GamesStatus> {
  const p = portsInput(body);
  const why = clash(p, listGamePorts(), await reserved());
  if (why) throw new AppError("invalid", why, 400, { field: /public port/i.test(why) ? "publicPort" : "ports" });
  const row = insertGamePort(p);
  g.__gluonJavaNeed = undefined;
  audit(user, { action: "games.port.add", target: row.id, summary: `Game ports: added ${p.name} (${portText(p)})`, detail: p }, where);
  return gamesStatus();
}

export async function editGamePort(user: User, where: Where, id: string, body: GamePortBody): Promise<GamesStatus> {
  const old = getGamePort(id);
  if (!old) throw new AppError("not_found", "That game port isn't there any more.", 404);
  const p = portsInput(body);
  const why = clash(p, listGamePorts().filter((x) => x.id !== id), await reserved());
  if (why) throw new AppError("invalid", why, 400, { field: /public port/i.test(why) ? "publicPort" : "ports" });
  updateGamePort(id, p);
  audit(user, { action: "games.port.update", target: id, summary: `Game ports: changed ${old.name}${old.name !== p.name ? ` (now ${p.name})` : ""} to ${portText(p)}`, detail: { before: old, after: p } }, where);
  return gamesStatus();
}

export async function removeGamePort(user: User, where: Where, id: string): Promise<GamesStatus> {
  const old = getGamePort(id);
  if (!old) throw new AppError("not_found", "That game port isn't there any more.", 404);
  deleteGamePort(id);
  audit(user, { action: "games.port.remove", target: id, summary: `Game ports: removed ${old.name} (${portText(old)})`, detail: old }, where);
  return gamesStatus();
}
