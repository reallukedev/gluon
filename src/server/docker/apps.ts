import "server-only";
import { activePlatform } from "../platform";
import { umbrelApps, umbrelAppState, umbrelStores, type UmbrelAppState, type UmbrelInstalledApp } from "../platform/umbrel";
import fs from "node:fs";
import YAML from "yaml";
import type Docker from "dockerode";
import { docker } from "./client";
import { hostPath } from "../host/paths";
import { host } from "../host/exec";
import { all, now, one, run } from "../db";
import { tryReadConfig, routeUrl, THIS_SERVER, type Route } from "../caddy/routes";
import type { LineState } from "@/lib/types";

export interface PortMapping {
  host: number;
  container: number;
  proto: "tcp" | "udp";
  ip: string;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  service: string | null;
  image: string;
  state: string; // docker state: running | exited | restarting | paused | created | dead
  health: "healthy" | "unhealthy" | "starting" | null;
  line: LineState;
  status: string;
  createdAt: number;
  ports: PortMapping[];
  networkMode: string;
}

export interface AppRouteRef {
  id: string;
  name: string;
  url: string;
  type: Route["type"];
  enabled: boolean;
  onlyPaths?: string[];
  /** The port on this server the address forwards to, when it points here. */
  port: number | null;
}

export interface AppSummary {
  id: string;
  kind: "stack" | "container";
  name: string;
  description: string | null;
  category: string | null;
  icon: string | null;
  source: "casaos" | "umbrel" | "compose" | "docker";
  configFile: string | null;
  workingDir: string | null;
  containers: ContainerSummary[];
  line: LineState;
  summary: string;
  webPort: number | null;
  urls: { home: string | null; away: string | null };
  routes: AppRouteRef[];
  household: boolean;
  hidden: boolean;
  hasLogin: "yes" | "no" | "unknown";
  self: boolean;
  /** Set for apps Umbrel manages, when Gluon works with Umbrel: its state and versions. */
  umbrel: { state: UmbrelAppState; progress: number; version: string; latest: string | null; storeId: string | null } | null;
  /** Set when this is an older install of an app that also runs from somewhere else (e.g. a CasaOS Immich next to Umbrel's). */
  copyOf: { id: string; name: string; source: AppSummary["source"] } | null;
}

interface CasaMeta {
  title?: string;
  icon?: string;
  portMap?: number;
  scheme?: string;
  index?: string;
  description?: string;
  category?: string;
  main?: string;
}

// ---------------------------------------------------------------- compose metadata

const metaCache = new Map<string, { mtime: number; meta: CasaMeta | null }>();

function pickLang(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, string>;
    return o.en_us ?? o.en_US ?? o.custom ?? Object.values(o)[0];
  }
  return undefined;
}

function casaMeta(configFile: string | null): CasaMeta | null {
  if (!configFile) return null;
  const p = hostPath(configFile);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  const cached = metaCache.get(configFile);
  if (cached && cached.mtime === st.mtimeMs) return cached.meta;
  let meta: CasaMeta | null = null;
  try {
    const doc = YAML.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    const x = doc?.["x-casaos"] as Record<string, unknown> | undefined;
    if (x) {
      const pm = Number(String(x.port_map ?? "").trim());
      meta = {
        title: pickLang(x.title),
        icon: typeof x.icon === "string" ? x.icon : undefined,
        portMap: Number.isFinite(pm) && pm > 0 ? pm : undefined,
        scheme: typeof x.scheme === "string" ? x.scheme : undefined,
        index: typeof x.index === "string" ? x.index : undefined,
        description: pickLang(x.tagline) ?? pickLang(x.description)?.split("\n")[0],
        category: typeof x.category === "string" ? x.category : undefined,
        main: typeof x.main === "string" ? x.main : undefined,
      };
    }
  } catch {
    meta = null;
  }
  metaCache.set(configFile, { mtime: st.mtimeMs, meta });
  return meta;
}

// ---------------------------------------------------------------- Umbrel apps

/**
 * Umbrel starts every app through its own internal compose files, so the container labels point
 * at umbreld's source tree, not at the app. The app's real manifest lives in Umbrel's data folder:
 * <root>/app-data/<appId>/umbrel-app.yml. The root is read off the app's own bind mounts, with the
 * usual install locations as a fallback.
 */
const UMBREL_ROOTS = ["/srv/umbrel", "/home/umbrel/umbrel", "/umbrel", "/DATA/AppData/umbrel/data"];

export function isUmbrelManaged(labels: Record<string, string>): boolean {
  const f = `${labels["com.docker.compose.project.config_files"] ?? ""} ${labels["com.docker.compose.project.working_dir"] ?? ""}`;
  return /\/umbreld\//.test(f);
}

function umbrelMeta(appId: string, cs: Docker.ContainerInfo[]): CasaMeta | null {
  const roots = new Set<string>();
  const re = new RegExp(`^(.*)/app-data/${appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);
  for (const c of cs) for (const m of c.Mounts ?? []) {
    const hit = m.Source && re.exec(m.Source);
    if (hit) roots.add(hit[1]!);
  }
  UMBREL_ROOTS.forEach((r) => roots.add(r));
  for (const root of roots) {
    const file = `${root}/app-data/${appId}/umbrel-app.yml`;
    let st: fs.Stats;
    try {
      st = fs.statSync(hostPath(file));
    } catch {
      continue;
    }
    const cached = metaCache.get(file);
    if (cached && cached.mtime === st.mtimeMs) return cached.meta;
    let meta: CasaMeta | null = null;
    try {
      const doc = YAML.parse(fs.readFileSync(hostPath(file), "utf8")) as Record<string, unknown>;
      const port = Number(doc.port);
      meta = {
        title: typeof doc.name === "string" ? doc.name : undefined,
        icon: typeof doc.icon === "string" ? doc.icon : undefined,
        portMap: Number.isFinite(port) && port > 0 ? port : undefined,
        index: typeof doc.path === "string" && doc.path ? doc.path : undefined,
        description: typeof doc.tagline === "string" ? doc.tagline : undefined,
        category: typeof doc.category === "string" ? doc.category : undefined,
      };
    } catch {
      meta = null;
    }
    metaCache.set(file, { mtime: st.mtimeMs, meta });
    return meta;
  }
  return null;
}

const UMBREL_STATE_TEXT: Partial<Record<UmbrelAppState, string>> = {
  installing: "Installing",
  updating: "Updating",
  uninstalling: "Uninstalling",
  starting: "Starting",
  stopping: "Stopping",
  restarting: "Restarting",
  stopped: "Stopped",
};

function umbrelInfo(u: UmbrelInstalledApp, latest: { version: string; storeId: string } | undefined): NonNullable<AppSummary["umbrel"]> {
  return {
    state: u.state,
    progress: 0,
    version: u.version,
    latest: latest && latest.version && latest.version !== u.version ? latest.version : null,
    storeId: latest?.storeId ?? null,
  };
}

// ---------------------------------------------------------------- helpers

export function containerLine(state: string, health: ContainerSummary["health"]): LineState {
  if (state === "running") {
    if (health === "unhealthy") return "unhealthy";
    if (health === "starting") return "starting";
    return "running";
  }
  if (state === "restarting") return "unhealthy";
  if (state === "paused") return "paused";
  if (state === "created") return "starting";
  return "stopped";
}

function healthFrom(status: string): ContainerSummary["health"] {
  if (/\(healthy\)/.test(status)) return "healthy";
  if (/\(unhealthy\)/.test(status)) return "unhealthy";
  if (/health: starting/.test(status)) return "starting";
  return null;
}

const KNOWN_WEB = new Set([80, 443, 3000, 5000, 5055, 7878, 8080, 8081, 8083, 8096, 8123, 8181, 8384, 8443, 8581, 8888, 8989, 9000, 9443, 2283, 4533, 5030]);

function titleCase(s: string) {
  return s
    .replace(/^big-bear-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Best-effort icon for apps without CasaOS metadata, from the selfh.st icon set. Tries the compose
 * project name and the image name (with -server/-app/-web suffixes removed) and remembers which exist.
 */
const iconExists = new Map<string, boolean | Promise<boolean>>();
const ICON_BASE = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/";

function checkIcon(name: string): boolean | Promise<boolean> {
  const known = iconExists.get(name);
  if (known !== undefined) return known;
  const p = fetch(`${ICON_BASE}${name}.svg`, { method: "HEAD", signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      iconExists.set(name, ok);
      return ok;
    });
  iconExists.set(name, p);
  return p;
}

function iconCandidates(projectOrName: string, image: string): string[] {
  const repo = image.split("@")[0]!.split(":")[0]!.split("/").pop() ?? "";
  const clean = (x: string) => x.toLowerCase().replace(/^(big-bear-|docker-|linuxserver-)/, "");
  const out = [clean(projectOrName), clean(repo), clean(repo).replace(/-(server|app|web|ui|frontend|backend|core)$/, ""), clean(projectOrName).replace(/-(server|app|web|ui|copy|\d+)$/, "")];
  return [...new Set(out)].filter((n) => /^[a-z0-9-]{2,40}$/.test(n));
}

async function guessIcon(projectOrName: string, image: string): Promise<string | null> {
  for (const n of iconCandidates(projectOrName, image)) {
    const r = checkIcon(n);
    if (r === true || (r !== false && (await r))) return `${ICON_BASE}${n}.svg`;
  }
  return null;
}

let lanHostCache: { at: number; value: string } | null = null;

/** The server's LAN address for "at home" links (e.g. 192.168.1.10). */
export async function lanHost(): Promise<string> {
  const override = (process.env.GLUON_LAN_HOST ?? process.env.TEND_LAN_HOST);
  if (override) return override;
  if (lanHostCache && Date.now() - lanHostCache.at < 10 * 60_000) return lanHostCache.value;
  try {
    const { stdout } = await host("ip", ["-4", "route", "get", "1.1.1.1"], { timeoutMs: 3000 });
    const ip = stdout.match(/\bsrc (\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (ip) lanHostCache = { at: Date.now(), value: ip };
  } catch {
    /* fall through */
  }
  return lanHostCache?.value ?? "localhost";
}

// ---------------------------------------------------------------- listing

interface PrefRow {
  app_id: string;
  display_name: string | null;
  description: string | null;
  icon: string | null;
  url_home: string | null;
  url_away: string | null;
  household: number;
  has_login: string | null;
  hidden: number;
}

let listCache: { at: number; value: Promise<AppSummary[]> } | null = null;

export function invalidateApps() {
  listCache = null;
}

/** Every app on the machine: compose stacks (CasaOS or not) and standalone containers. Cached 3 s. */
export function listApps(): Promise<AppSummary[]> {
  if (listCache && Date.now() - listCache.at < 3000) return listCache.value;
  const value = buildApps();
  listCache = { at: Date.now(), value };
  value.catch(() => {
    listCache = null;
  });
  return value;
}

function toSummary(c: Docker.ContainerInfo): ContainerSummary {
  const health = healthFrom(c.Status);
  const ports: PortMapping[] = [];
  const seen = new Set<string>();
  for (const p of c.Ports ?? []) {
    if (!p.PublicPort) continue;
    const key = `${p.PublicPort}/${p.Type}`;
    if (seen.has(key)) continue; // IPv4 + IPv6 duplicates
    seen.add(key);
    ports.push({ host: p.PublicPort, container: p.PrivatePort, proto: p.Type as "tcp" | "udp", ip: p.IP ?? "" });
  }
  ports.sort((a, b) => a.host - b.host);
  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
    service: c.Labels?.["com.docker.compose.service"] ?? null,
    image: c.Image,
    state: c.State,
    health,
    line: containerLine(c.State, health),
    status: c.Status,
    createdAt: c.Created * 1000,
    ports,
    networkMode: c.HostConfig?.NetworkMode ?? "default",
  };
}

function aggregate(containers: ContainerSummary[]): { line: LineState; summary: string } {
  const n = containers.length;
  const count = (l: LineState) => containers.filter((c) => c.line === l).length;
  const running = count("running");
  const unhealthy = containers.filter((c) => c.line === "unhealthy");
  const starting = count("starting");
  const stopped = count("stopped");
  if (n === 0) return { line: "unknown", summary: "No containers" };
  if (unhealthy.length) {
    const restarting = unhealthy.filter((c) => c.state === "restarting").length;
    return {
      line: "unhealthy",
      summary: restarting ? `${restarting === n ? "Restarting over and over" : `${restarting} of ${n} restarting`}` : `${unhealthy.length === n ? "Unhealthy" : `${unhealthy.length} of ${n} unhealthy`}`,
    };
  }
  if (stopped === n) return { line: "stopped", summary: "Stopped" };
  if (starting) return { line: "starting", summary: n === 1 ? "Starting" : `${starting} of ${n} starting` };
  if (stopped) return { line: "unhealthy", summary: `${stopped} of ${n} stopped` };
  if (count("paused") === n) return { line: "paused", summary: "Paused" };
  return { line: running === n ? "running" : "starting", summary: "Running" };
}

/**
 * Two installs of the same app ("Immich" from Umbrel and an older one from CasaOS) are confusing
 * side by side. Same-named apps are grouped; the one Umbrel manages (else the one running) is the
 * app, and the others become its "old copy" when they're stopped, or when Umbrel runs the app.
 */
const sameApp = (name: string) => name.toLowerCase().replace(/^big[\s-]*bear[\s-]+/, "").replace(/[^a-z0-9]+/g, "");

function markCopies(apps: AppSummary[]) {
  const groups = new Map<string, AppSummary[]>();
  for (const a of apps) {
    if (a.self) continue;
    const k = sameApp(a.name);
    if (k) groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const live = (a: AppSummary) => a.line !== "stopped" && a.containers.length > 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const rank = (a: AppSummary) => (a.source === "umbrel" ? 2 : 0) + (live(a) ? 1 : 0);
    const primary = [...g].sort((a, b) => rank(b) - rank(a))[0]!;
    for (const a of g) {
      if (a === primary) continue;
      if (a.source === "umbrel") continue; // two Umbrel apps: both are real
      if (primary.source === "umbrel" || (live(primary) && !live(a))) {
        a.copyOf = { id: primary.id, name: primary.name, source: primary.source };
        // A stopped copy's "at home" address would open whatever answers on that port now,
        // usually the app that replaced it.
        if (!live(a) && a.urls.home && a.webPort && a.webPort === primary.webPort) a.urls.home = null;
      }
    }
  }
}

async function buildApps(): Promise<AppSummary[]> {
  // Working with Umbrel: its own view of each app (name, icon, port, state, version) wins over
  // the manifest files, and the store says whether a newer version exists. None of it waits on
  // Docker's list (nor the LAN address), so all three are asked at once.
  const umbrelView = activePlatform().then((p) => {
    const on = p === "umbrel";
    return Promise.all([on ? umbrelApps().catch(() => null) : null, on ? umbrelStores().catch(() => null) : null]);
  });
  const [list, [uApps, uStores], lan] = await Promise.all([docker().listContainers({ all: true }), umbrelView, lanHost()]);
  const uById = new Map((uApps ?? []).map((a) => [a.id, a]));
  const latestById = new Map<string, { version: string; storeId: string }>();
  for (const st of uStores ?? []) for (const a of st.apps) if (!latestById.has(a.id)) latestById.set(a.id, { version: a.version, storeId: st.id });
  const prefs = new Map(all<PrefRow>("SELECT * FROM app_prefs").map((r) => [r.app_id, r]));
  const routesCfg = tryReadConfig();
  const selfId = process.env.HOSTNAME ?? "";

  const groups = new Map<string, Docker.ContainerInfo[]>();
  for (const c of list) {
    const project = c.Labels?.["com.docker.compose.project"];
    const key = project ? `stack:${project}` : `ctr:${(c.Names?.[0] ?? c.Id).replace(/^\//, "")}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  // A Compose project name Umbrel and another installer both used (CasaOS's "jellyfin" next to
  // Umbrel's) would merge two different apps. Split the non-Umbrel containers into their own app.
  // It shares the project name with Umbrel's, so it's managed container by container: a Compose
  // `up --remove-orphans` on its file would delete Umbrel's containers.
  const shared = new Set<string>();
  for (const [key, cs] of [...groups]) {
    if (!key.startsWith("stack:")) continue;
    const mine = cs.filter((c) => isUmbrelManaged(c.Labels ?? {}));
    if (!mine.length || mine.length === cs.length) continue;
    const others = cs.filter((c) => !isUmbrelManaged(c.Labels ?? {}));
    const casa = /\/casaos\//.test(others[0]!.Labels?.["com.docker.compose.project.config_files"] ?? "");
    const otherKey = `${key}.${casa ? "casaos" : "compose"}`;
    groups.set(key, mine);
    groups.set(otherKey, others);
    shared.add(otherKey);
  }

  // Ports each app serves, for matching public addresses to the app that answers them.
  const served = new Map<string, { ports: Set<number>; running: boolean }>();
  const apps: AppSummary[] = [];
  // Guessing an icon can ask the icon CDN (once per name): every app asks at once, not one after another.
  const guesses: Promise<void>[] = [];
  for (const [key, cs] of groups) {
    const isStack = key.startsWith("stack:");
    const id = key.slice(key.indexOf(":") + 1);
    const split = shared.has(key);
    const labels = cs[0]!.Labels ?? {};
    // Umbrel apps: never hand umbreld's internal compose files to `docker compose` (an `up
    // --remove-orphans` against them would delete the app's other containers). Container-level
    // start/stop/restart still work; install, update and removal stay in Umbrel.
    const umbrel = isStack && isUmbrelManaged(labels);
    const ownFile = isStack && !umbrel ? (labels["com.docker.compose.project.config_files"]?.split(",")[0] ?? null) : null;
    const configFile = split ? null : ownFile;
    const workingDir = isStack && !umbrel && !split ? (labels["com.docker.compose.project.working_dir"] ?? null) : null;
    const u = umbrel ? uById.get(id) : undefined;
    const fileMeta = umbrel ? umbrelMeta(id, cs) : casaMeta(ownFile);
    const meta: CasaMeta | null = u
      ? { ...fileMeta, title: u.name, icon: u.icon ?? fileMeta?.icon, portMap: u.port ?? fileMeta?.portMap, index: u.path || fileMeta?.index }
      : fileMeta;
    const containers = cs.map(toSummary).sort((a, b) => a.name.localeCompare(b.name));
    const main = (meta?.main && containers.find((c) => c.service === meta.main)) || containers[0]!;
    const pref = prefs.get(id);
    let { line, summary } = aggregate(containers);
    if (u && u.state !== "ready" && u.state !== "running" && u.state !== "stopped" && UMBREL_STATE_TEXT[u.state]) {
      line = "starting";
      summary = UMBREL_STATE_TEXT[u.state]!;
    }

    const allPorts = containers.flatMap((c) => c.ports.filter((p) => p.proto === "tcp").map((p) => p.host));
    const webPort = meta?.portMap ?? allPorts.find((p) => KNOWN_WEB.has(p)) ?? allPorts[0] ?? null;
    const running = containers.some((c) => c.state === "running");
    // Host-network containers publish nothing, but answer on the app's own port.
    const ports = new Set(allPorts);
    if (webPort && containers.some((c) => c.networkMode === "host" && c.state === "running")) ports.add(webPort);
    served.set(id, { ports, running });

    const scheme = meta?.scheme ?? "http";
    const index = meta?.index && meta.index !== "/" ? meta.index : "";
    const home = pref?.url_home || (webPort ? `${scheme}://${lan}:${webPort}${index}` : null);
    const baseName = pref?.display_name || meta?.title || (umbrel && id === "umbrelc" ? "Umbrel services" : titleCase(isStack ? id.replace(/\.(casaos|compose)$/, "") : main.name));

    const app: AppSummary = {
      id,
      kind: isStack ? "stack" : "container",
      name: baseName,
      description: pref?.description || meta?.description || null,
      category: meta?.category ?? null,
      icon: pref?.icon || meta?.icon || null,
      source: umbrel ? "umbrel" : meta ? "casaos" : isStack ? "compose" : "docker",
      configFile,
      workingDir,
      containers,
      line,
      summary,
      webPort,
      urls: { home, away: pref?.url_away || null },
      routes: [],
      household: !!pref?.household,
      hidden: !!pref?.hidden,
      hasLogin: (pref?.has_login as AppSummary["hasLogin"]) ?? "unknown",
      self: containers.some((c) => c.shortId === selfId.slice(0, 12) || c.name === "gluon" || c.name === "gluon-dev" || c.name === "tend" || c.name === "tend-dev"),
      umbrel: u ? umbrelInfo(u, latestById.get(id)) : null,
      copyOf: null,
    };
    if (!app.icon)
      guesses.push(
        guessIcon(isStack ? id.replace(/\.(casaos|compose)$/, "") : main.name, main.image).then((icon) => {
          app.icon = icon;
        }),
      );
    apps.push(app);
  }
  // Apps Umbrel knows about that have no containers yet (installing) or any more (uninstalling).
  for (const u of uApps ?? []) {
    if (groups.has(`stack:${u.id}`)) continue;
    const pref = prefs.get(u.id);
    apps.push({
      id: u.id,
      kind: "stack",
      name: pref?.display_name || u.name,
      description: pref?.description || null,
      category: null,
      icon: pref?.icon || u.icon,
      source: "umbrel",
      configFile: null,
      workingDir: null,
      containers: [],
      line: u.state === "installing" || u.state === "starting" || u.state === "updating" ? "starting" : "stopped",
      summary: UMBREL_STATE_TEXT[u.state] ?? "Not running",
      webPort: u.port,
      urls: { home: null, away: null },
      routes: [],
      household: !!pref?.household,
      hidden: !!pref?.hidden,
      hasLogin: (pref?.has_login as AppSummary["hasLogin"]) ?? "unknown",
      self: false,
      umbrel: umbrelInfo(u, latestById.get(u.id)),
      copyOf: null,
    });
  }

  // Public addresses: a route belongs to the app it names and to any app serving its port. When
  // one of those is running and actually answers on the port, only that one gets it, so an old
  // stopped copy doesn't claim the address its replacement now serves.
  if (routesCfg) {
    for (const r of routesCfg.routes) {
      if (r.type === "redirect") continue;
      const b = r.backend;
      const port = b.host === THIS_SERVER ? b.port : null;
      const matches = apps.filter((a) => (r.app && r.app === a.id) || (port !== null && served.get(a.id)?.ports.has(port)));
      const answering = matches.filter((a) => port !== null && served.get(a.id)?.running && served.get(a.id)?.ports.has(port));
      const ref: AppRouteRef = { id: r.id, name: r.name, url: routeUrl(routesCfg, r), type: r.type, enabled: r.enabled !== false, onlyPaths: r.type === "subdomain" ? r.only_paths : undefined, port };
      for (const a of answering.length ? answering : matches) a.routes.push(ref);
    }
    for (const a of apps) {
      const awayRoute = a.routes.find((r) => r.enabled && r.type === "subdomain" && !r.onlyPaths?.length) ?? a.routes.find((r) => r.enabled && r.type === "path");
      a.urls.away ||= awayRoute?.url ?? null;
    }
  }

  // Umbrel is installing, updating or removing: ask how far along it is (while the icon guesses finish).
  await Promise.all([
    ...guesses,
    ...apps
      .filter((a) => a.umbrel && (a.umbrel.state === "installing" || a.umbrel.state === "updating" || a.umbrel.state === "uninstalling"))
      .map(async (a) => {
        const st = await umbrelAppState(a.id).catch(() => null);
        if (st && a.umbrel) a.umbrel.progress = Math.max(0, Math.min(100, Math.round(st.progress || 0)));
      }),
  ]);

  markCopies(apps);
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getApp(id: string): Promise<AppSummary | null> {
  return (await listApps()).find((a) => a.id === id) ?? null;
}

/** Apps a household member can see. */
export async function appsForMember(userId: string): Promise<AppSummary[]> {
  const granted = new Set(all<{ app_id: string }>("SELECT app_id FROM app_access WHERE user_id = ?", userId).map((r) => r.app_id));
  return (await listApps()).filter((a) => !a.hidden && (a.household || granted.has(a.id)));
}

export function setAppPrefs(id: string, patch: Partial<{ display_name: string | null; description: string | null; icon: string | null; url_home: string | null; url_away: string | null; household: boolean; has_login: string; hidden: boolean }>) {
  const cur = one<PrefRow>("SELECT * FROM app_prefs WHERE app_id = ?", id);
  const next = {
    display_name: patch.display_name !== undefined ? patch.display_name : (cur?.display_name ?? null),
    description: patch.description !== undefined ? patch.description : (cur?.description ?? null),
    icon: patch.icon !== undefined ? patch.icon : (cur?.icon ?? null),
    url_home: patch.url_home !== undefined ? patch.url_home : (cur?.url_home ?? null),
    url_away: patch.url_away !== undefined ? patch.url_away : (cur?.url_away ?? null),
    household: patch.household !== undefined ? (patch.household ? 1 : 0) : (cur?.household ?? 0),
    has_login: patch.has_login ?? cur?.has_login ?? "unknown",
    hidden: patch.hidden !== undefined ? (patch.hidden ? 1 : 0) : (cur?.hidden ?? 0),
  };
  run(
      `INSERT INTO app_prefs (app_id, display_name, description, icon, url_home, url_away, household, has_login, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, icon = excluded.icon,
         url_home = excluded.url_home, url_away = excluded.url_away, household = excluded.household, has_login = excluded.has_login,
         hidden = excluded.hidden, updated_at = excluded.updated_at`,
      id,
      next.display_name,
      next.description,
      next.icon,
      next.url_home,
      next.url_away,
      next.household,
      next.has_login,
      next.hidden,
      now(),
  );
  invalidateApps();
}
