import "server-only";
import path from "node:path";
import YAML from "yaml";
import type { MoveCopy, MovePort, MoveSource, MoveStay } from "@/lib/app-move-types";
import { envLine, interpolate, learnVars, splitColons, varsIn } from "./vars";
import { norm, relativeTo, resolveFrom, slugify, usersOf, within, type BindUse } from "./paths";

/**
 * Turns an app's compose file into one Gluon runs from its own folder. Pure: everything it needs
 * to know about the server (real mount paths, volumes, who uses what) comes in as data.
 *
 * - Bind mounts inside the old app's own folders are copied into the new folder and written as
 *   ./relative paths. Everything else (media libraries, /home, sockets) stays where it is and is
 *   written as the absolute path it resolved to.
 * - Named volumes only this app uses become folders under ./volumes (copied), so the app's data
 *   all lives in one folder. Volumes other apps share, or that aren't plain local volumes, are
 *   used in place as external volumes.
 * - container_name goes (the stopped original still holds those names); each old name becomes a
 *   network alias so the app's services, and anything else on its networks, still find each other.
 * - Umbrel: app_proxy is dropped and its port published on the app directly; Umbrel's network and
 *   fixed addresses go; Umbrel's variables resolve through a .env next to the file.
 */

export interface RuntimeMount {
  type: string;
  source: string;
  destination: string;
  name?: string;
  rw: boolean;
}

/** What the running (or stopped) container for a service really has, from `docker inspect`. */
export interface ServiceRuntime {
  service: string;
  container: string;
  mounts: RuntimeMount[];
  env: string[];
  hostname?: string;
}

export interface VolumeInfo {
  name: string;
  mountpoint: string;
  driver: string;
  /** driver_opts or labels that make it more than a plain local volume (nfs, a bind in disguise). */
  hasOptions: boolean;
  /** Names of every container that mounts it. */
  usedBy: string[];
}

/** One of the old app's own folders, and where its contents go under the new folder ("" = the folder itself). */
export interface OwnDir {
  path: string;
  to: string;
}

export interface AppMeta {
  name: string;
  icon: string | null;
  description: string | null;
  webPort: number | null;
  path: string | null;
}

export interface RewriteInput {
  source: Exclude<MoveSource, "docker">;
  appId: string;
  /** The old Compose project. */
  project: string;
  newProject: string;
  newDir: string;
  composeText: string;
  /** Where the old file's relative paths resolve. */
  workingDir: string | null;
  ownDirs: OwnDir[];
  /** Values the old app's variables had (the project's .env, Umbrel's own). */
  vars: Record<string, string>;
  /** Values that differ for the new copy (Umbrel's APP_DATA_DIR becomes the new folder). */
  newVars?: Record<string, string>;
  /** The old project's .env, kept as it was in the new folder. */
  dotenvText?: string | null;
  runtime: ServiceRuntime[];
  volumes: VolumeInfo[];
  /** This app's container names (everyone else's use of a volume makes it shared). */
  appContainers: string[];
  /** Every bind mount on the server: a folder another container also mounts is never copied. */
  binds?: BindUse[];
  meta: AppMeta;
  umbrel?: { proxyPort: number | null; dependencies: string[]; hooks: string[] };
}

export type PlannedCopy = Omit<MoveCopy, "size" | "missing">;

export interface Rewritten {
  compose: string;
  /** The new folder's .env, or null when nothing needs one. */
  envText: string | null;
  copies: PlannedCopy[];
  stays: MoveStay[];
  sharedVolumes: string[];
  ports: MovePort[];
  /** A port Umbrel's login guarded that the copy answers on directly. */
  loginLostPort?: number | null;
  warnings: string[];
  blockers: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const ANON = /^[0-9a-f]{64}$/;
const UMBREL_NETWORK = "umbrel_main_network";

/** Collects what a rewrite copies, keeps and warns about. */
export class Collector {
  copies = new Map<string, PlannedCopy>();
  stays = new Map<string, MoveStay>();
  shared = new Set<string>();
  warnings: string[] = [];
  blockers: string[] = [];
  constructor(readonly newDir: string) {}

  copy(from: string, to: string, kind: PlannedCopy["kind"], service: string, volume?: string) {
    if (!within(to, this.newDir) || to === this.newDir) {
      this.blockers.push(`Gluon would have copied ${from} outside the new folder. Nothing was changed.`);
      return;
    }
    const cur = this.copies.get(from);
    if (cur) {
      if (!cur.services.includes(service)) cur.services.push(service);
      return;
    }
    this.copies.set(from, { from, to, kind, services: [service], ...(volume ? { volume } : {}) });
  }

  stay(p: string, service: string, readOnly: boolean) {
    const cur = this.stays.get(p);
    if (cur) {
      if (!cur.services.includes(service)) cur.services.push(service);
      cur.readOnly &&= readOnly;
      return;
    }
    this.stays.set(p, { path: p, services: [service], readOnly });
  }

  warn(w: string) {
    if (!this.warnings.includes(w)) this.warnings.push(w);
  }

  block(b: string) {
    if (!this.blockers.includes(b)) this.blockers.push(b);
  }

  /** Copies nested inside another copy are already covered by it. */
  finalCopies(): PlannedCopy[] {
    const all = [...this.copies.values()];
    return all.filter((c) => !all.some((o) => o !== c && o.kind !== "volume" && c.kind !== "volume" && within(c.from, o.from) && c.from !== o.from));
  }
}

// ---------------------------------------------------------------- ports

/** Host ports a service publishes, from short ("127.0.0.1:8080:80/udp") or long syntax. */
export function publishedPorts(service: string, ports: unknown, vars: Record<string, string> = {}): MovePort[] {
  if (!Array.isArray(ports)) return [];
  const out: MovePort[] = [];
  for (const p of ports) {
    if (isObj(p)) {
      const host = Number(interpolate(str(p.published) ?? "", vars).value.split("-")[0]);
      const container = Number(interpolate(str(p.target) ?? "", vars).value) || null;
      if (host > 0) out.push({ host, container, proto: p.protocol === "udp" ? "udp" : "tcp", service });
      continue;
    }
    const s = str(p);
    if (!s) continue;
    const v = interpolate(s, vars).value;
    const [spec, proto = "tcp"] = v.split("/");
    const bits = spec!.split(":");
    if (bits.length < 2) continue; // container port only: Docker picks a random host port
    const hostPart = bits[bits.length - 2]!;
    const contPart = bits[bits.length - 1]!;
    const [h1, h2] = hostPart.split("-").map(Number);
    const [c1] = contPart.split("-").map(Number);
    if (!h1) continue;
    const last = h2 && h2 >= h1 ? Math.min(h2, h1 + 64) : h1;
    for (let h = h1; h <= last; h++) out.push({ host: h, container: c1 ? c1 + (h - h1) : null, proto: proto === "udp" ? "udp" : "tcp", service });
  }
  return out;
}

// ---------------------------------------------------------------- volumes

interface VolEntry {
  source: string | null;
  target: string;
  type: string;
  readOnly: boolean;
  mode: string[];
  long: Obj | null;
}

function parseVolume(v: unknown): VolEntry | null {
  if (isObj(v)) {
    const target = str(v.target);
    if (!target) return null;
    return { source: str(v.source), target, type: str(v.type) ?? "volume", readOnly: v.read_only === true, mode: [], long: v };
  }
  const s = str(v);
  if (!s) return null;
  const bits = splitColons(s);
  if (bits.length === 1) return { source: null, target: bits[0]!, type: "volume", readOnly: false, mode: [], long: null };
  const mode = bits.length > 2 ? bits.slice(2).join(":").split(",") : [];
  return { source: bits[0]!, target: bits[1]!, type: "", readOnly: mode.includes("ro"), mode, long: null };
}

function writeVolume(e: VolEntry, source: string, type: "bind" | "volume"): unknown {
  if (e.long) {
    const out: Obj = { ...e.long, type, source };
    if (type === "bind") delete out.volume;
    else delete out.bind;
    return out;
  }
  const mode = e.mode.filter((m) => m && (type === "volume" || m !== "nocopy"));
  return `${source}:${e.target}${mode.length ? `:${mode.join(",")}` : ""}`;
}

const looksLikePath = (s: string) => s.startsWith("/") || s.startsWith(".") || s.startsWith("~");

export const anonFolder = (service: string, target: string) => `./volumes/${slugify(service)}-${slugify(target.replace(/\//g, "-"), "data")}`;

// ---------------------------------------------------------------- the rewrite

export function rewriteCompose(input: RewriteInput): Rewritten {
  const c = new Collector(input.newDir);
  let doc: Obj;
  try {
    const parsed = YAML.parse(input.composeText, { merge: true, maxAliasCount: -1 });
    if (!isObj(parsed) || !isObj(parsed.services)) throw new Error("no services");
    doc = parsed;
  } catch {
    return { compose: "", envText: null, copies: [], stays: [], sharedVolumes: [], ports: [], warnings: [], blockers: ["Gluon couldn't read this app's compose file."] };
  }
  const services = doc.services as Record<string, Obj>;
  const topVolumes = isObj(doc.volumes) ? (doc.volumes as Record<string, Obj | null>) : {};
  const topNetworks = isObj(doc.networks) ? (doc.networks as Record<string, Obj | null>) : {};
  const umbrel = input.source === "umbrel";

  if (umbrel && input.umbrel?.dependencies.length) {
    c.block(`It depends on ${input.umbrel.dependencies.join(", ")} from Umbrel, which would stop working once it leaves Umbrel's network.`);
  }

  // Variables: what the file says, lined up with what the containers really got.
  const known: Record<string, string> = { ...input.vars };
  const runtimeOf = new Map(input.runtime.map((r) => [r.service, r]));
  for (const [name, svc] of Object.entries(services)) {
    const rt = runtimeOf.get(name);
    if (!rt || !isObj(svc)) continue;
    const learn = (tpl: string | null, actual: string | undefined) => {
      if (!tpl || actual === undefined || !varsIn(tpl).length) return;
      const got = learnVars(tpl, actual);
      if (got) for (const [k, v] of Object.entries(got)) if (known[k] === undefined) known[k] = v;
    };
    const actualEnv = new Map(rt.env.map((e) => [e.slice(0, e.indexOf("=") < 0 ? e.length : e.indexOf("=")), e.includes("=") ? e.slice(e.indexOf("=") + 1) : ""]));
    for (const [k, tpl] of envEntries(svc.environment)) learn(tpl, actualEnv.get(k));
    learn(str(svc.hostname), rt.hostname);
    for (const raw of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const e = parseVolume(raw);
      const m = e && rt.mounts.find((x) => x.destination === e.target);
      if (e?.source && m?.type === "bind") learn(e.source, m.source);
    }
  }
  const forNew: Record<string, string> = { ...known, ...input.newVars };

  // Umbrel's proxy: which service serves the page, and on which port.
  let proxy: { host: string | null; port: string | null; auth: boolean } | null = null;
  /** The port the page ends up on without Umbrel's login in front of it. */
  let unguarded: number | null = null;
  if (umbrel && isObj(services.app_proxy)) {
    const env = new Map(envEntries(services.app_proxy.environment));
    const val = (k: string) => {
      const v = env.get(k);
      return v === undefined || v === null ? null : interpolate(v, known).value;
    };
    // Umbrel's proxy asks for Umbrel's login unless the app turns it off (PROXY_AUTH_ADD: "false",
    // the default being true) or lets every path through (PROXY_AUTH_WHITELIST: "*").
    const whitelist = (val("PROXY_AUTH_WHITELIST") ?? "").split(",").map((x) => x.trim());
    const auth = (val("PROXY_AUTH_ADD") ?? "true").toLowerCase() !== "false" && !whitelist.some((w) => w === "*" || w === "/*");
    proxy = { host: val("APP_HOST"), port: val("APP_PORT"), auth };
    delete services.app_proxy;
  }

  // Networks: Umbrel's goes, project-scoped names become this project's own, fixed subnets go.
  const removedNets = new Set<string>();
  const unaddressed = new Set<string>();
  for (const [key, def] of Object.entries(topNetworks)) {
    const d = isObj(def) ? def : {};
    if (d.external) {
      const name = str(d.name) ?? (isObj(d.external) ? str((d.external as Obj).name) : null) ?? key;
      if (name === UMBREL_NETWORK) {
        delete topNetworks[key];
        removedNets.add(key);
      }
      continue;
    }
    const explicit = str(d.name);
    if (explicit) {
      if (input.source === "casaos" || explicit.startsWith(`${input.project}_`) || explicit.startsWith(`${input.project}-`)) {
        delete d.name;
      } else {
        topNetworks[key] = { external: true, name: explicit };
        c.warn(`It joins the network “${explicit}”, which the old copy created. The copy uses the same network, so remove the old copy with Gluon (its network stays while the copy needs it).`);
        unaddressed.add(key);
        continue;
      }
    }
    if (isObj(d.ipam) && Array.isArray((d.ipam as Obj).config) && ((d.ipam as Obj).config as unknown[]).length) {
      delete (d.ipam as Obj).config;
      if (!Object.keys(d.ipam as Obj).length) delete d.ipam;
      unaddressed.add(key);
      c.warn(`The network “${key}” had a fixed address range that the old copy's network still holds, so the copy lets Docker pick one.`);
    }
    topNetworks[key] = Object.keys(d).length ? d : null;
  }

  const nameToService = new Map<string, string>();
  for (const [name, svc] of Object.entries(services)) {
    const cn = isObj(svc) ? str(svc.container_name) : null;
    if (cn) nameToService.set(interpolate(cn, known).value, name);
  }

  const ports: MovePort[] = [];
  const usedTopVolumes = new Set<string>();
  const mine = new Set(input.appContainers);

  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc)) continue;
    const rt = runtimeOf.get(name);
    if (svc.extends) c.block(`“${name}” extends another file, which Gluon can't rewrite yet.`);

    // Paths the service reads from the server.
    const placePath = (raw: string, what: "folder" | "file", readOnly = what === "file"): string | null => {
      const r = interpolate(raw, known);
      if (r.missing.length) {
        c.block(`Gluon couldn't work out ${r.missing.join(", ")} in “${name}”.`);
        return null;
      }
      const abs = resolveFrom(r.value, input.workingDir);
      if (!abs) {
        c.block(`“${name}” uses ${raw}, which Gluon can't place on the server.`);
        return null;
      }
      return place(abs, what, readOnly);
    };
    const place = (abs: string, what: "folder" | "file", readOnly = false): string => {
      const own = input.ownDirs.find((d) => within(abs, d.path));
      const others = own ? usersOf(abs, input.binds ?? [], mine, { broadParents: false }) : [];
      if (others.length) c.warn(`${abs} is also used by ${others.join(", ")}, so the copy uses it in place instead of copying it.`);
      if (!own || others.length) {
        c.stay(abs, name, readOnly);
        return abs;
      }
      const dest = norm(path.posix.join(input.newDir, own.to, path.posix.relative(own.path, abs)))!;
      if (input.dotenvText != null && input.workingDir && abs === norm(`${input.workingDir}/.env`)) return "./.env";
      c.copy(abs, dest, what, name);
      return relativeTo(input.newDir, dest);
    };

    // Volumes.
    const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
    const outVols: unknown[] = [];
    const covered = new Set<string>();
    for (const raw of vols) {
      const e = parseVolume(raw);
      if (!e) {
        outVols.push(raw);
        continue;
      }
      covered.add(e.target);
      const mount = rt?.mounts.find((m) => m.destination === e.target);
      if (e.type === "tmpfs" || e.type === "npipe" || e.type === "image" || e.type === "cluster") {
        outVols.push(raw);
        continue;
      }
      if (e.source === null) {
        // Anonymous volume declared in the file: the copy gets the data as a folder.
        const folder = anonFolder(name, e.target);
        if (mount?.type === "volume" && mount.name) c.copy(mount.source, path.posix.join(input.newDir, folder.slice(2)), "volume", name, mount.name);
        outVols.push(writeVolume(e, folder, "bind"));
        continue;
      }
      const interp = interpolate(e.source, known);
      // Volume names never hold a slash, so anything with one is a path, even with unknown variables.
      const isBind = e.type === "bind" || (e.type === "" && (looksLikePath(interp.value) || e.source.includes("/") || mount?.type === "bind"));
      if (isBind) {
        if (mount?.type === "bind" && norm(mount.source)) {
          outVols.push(writeVolume(e, place(norm(mount.source)!, "folder", e.readOnly || !mount.rw), "bind"));
        } else {
          const p = placePath(e.source, "folder", e.readOnly);
          outVols.push(p ? writeVolume(e, p, "bind") : raw);
        }
        continue;
      }
      // A named volume.
      const key = interp.value;
      const def = isObj(topVolumes[key]) ? (topVolumes[key] as Obj) : null;
      const declaredName = def ? (str(def.name) ?? (def.external ? key : null)) : null;
      const fullName = mount?.name ?? (declaredName ? interpolate(declaredName, known).value : `${input.project}_${key}`);
      const info = input.volumes.find((v) => v.name === fullName);
      const others = info ? info.usedBy.filter((u) => !input.appContainers.includes(u)) : [];
      const shared = !!def?.external || !!str(def?.name) || others.length > 0 || (info ? info.driver !== "local" || info.hasOptions : false) || !!(def && (def.driver || def.driver_opts));
      if (shared) {
        topVolumes[key] = { external: true, name: fullName };
        usedTopVolumes.add(key);
        c.shared.add(fullName);
        outVols.push(writeVolume(e, key, "volume"));
        if (others.length) c.warn(`The volume “${fullName}” is also used by ${others.join(", ")}, so the copy uses it in place instead of copying it.`);
        continue;
      }
      const folder = `./volumes/${slugify(key, "volume")}`;
      if (info) c.copy(info.mountpoint, path.posix.join(input.newDir, folder.slice(2)), "volume", name, fullName);
      outVols.push(writeVolume(e, folder, "bind"));
    }
    // Volumes the image declares that the file doesn't mention still hold data.
    for (const m of rt?.mounts ?? []) {
      if (m.type !== "volume" || !m.name || !ANON.test(m.name) || covered.has(m.destination)) continue;
      const folder = anonFolder(name, m.destination);
      c.copy(m.source, path.posix.join(input.newDir, folder.slice(2)), "volume", name, m.name);
      outVols.push(`${folder}:${m.destination}`);
    }
    if (outVols.length) svc.volumes = outVols;
    else delete svc.volumes;

    // env_file, build context, configs.
    if (svc.env_file !== undefined) {
      const list = Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
      svc.env_file = list.map((f) => {
        if (isObj(f)) {
          const p = str(f.path);
          const placed = p ? placePath(p, "file") : null;
          return placed ? { ...f, path: placed } : f;
        }
        const p = str(f);
        return (p && placePath(p, "file")) ?? f;
      });
    }
    if (svc.build !== undefined) {
      const b = isObj(svc.build) ? svc.build : { context: svc.build };
      const ctx = str(b.context) ?? ".";
      if (/^[a-z]+:\/\/|^git@/.test(ctx)) {
        /* a remote context builds the same from anywhere */
      } else {
        const placed = placePath(ctx, "folder");
        if (placed) {
          if (placed.startsWith("/")) c.warn(`“${name}” is built from ${placed}, outside the app's folder. The copy builds from there too.`);
          svc.build = isObj(svc.build) ? { ...b, context: placed } : placed;
        }
      }
    }

    // Names and networks.
    const oldName = str(svc.container_name) ? interpolate(str(svc.container_name)!, known).value : null;
    delete svc.container_name;
    const mode = str(svc.network_mode);
    if (mode?.startsWith("container:")) {
      const target = nameToService.get(mode.slice("container:".length));
      if (target) svc.network_mode = `service:${target}`;
      else c.warn(`“${name}” shares the network of the container ${mode.slice("container:".length)}, which isn't part of this app.`);
    } else if (!mode) {
      let nets: Record<string, Obj | null>;
      if (Array.isArray(svc.networks)) nets = Object.fromEntries((svc.networks as unknown[]).map((n) => [String(n), null]));
      else if (isObj(svc.networks)) nets = { ...(svc.networks as Record<string, Obj | null>) };
      else nets = { default: null };
      for (const k of Object.keys(nets)) if (removedNets.has(k)) delete nets[k];
      if (!Object.keys(nets).length) nets = { default: null };
      for (const [k, cfg] of Object.entries(nets)) {
        const n: Obj = isObj(cfg) ? { ...cfg } : {};
        if (umbrel || unaddressed.has(k)) {
          delete n.ipv4_address;
          delete n.ipv6_address;
        }
        if (oldName && oldName !== name) {
          const aliases = Array.isArray(n.aliases) ? (n.aliases as unknown[]).map(String) : [];
          if (!aliases.includes(oldName)) aliases.push(oldName);
          n.aliases = aliases;
        }
        nets[k] = Object.keys(n).length ? n : null;
      }
      const plain = Object.keys(nets).length === 1 && nets.default === null;
      if (plain) delete svc.networks;
      else svc.networks = nets;
    }

    // Umbrel's proxy is gone, so nothing waits for it.
    if (umbrel) {
      if (Array.isArray(svc.depends_on)) svc.depends_on = (svc.depends_on as unknown[]).filter((d) => d !== "app_proxy");
      else if (isObj(svc.depends_on)) delete (svc.depends_on as Obj).app_proxy;
      if ((Array.isArray(svc.depends_on) && !(svc.depends_on as unknown[]).length) || (isObj(svc.depends_on) && !Object.keys(svc.depends_on as Obj).length)) delete svc.depends_on;
    }

    // The page Umbrel's proxy served is published straight from the app, on the same port.
    if (proxy?.host && (proxy.host === oldName || proxy.host === name || proxy.host === `${input.appId}_${name}_1`)) {
      const hostPort = input.umbrel?.proxyPort ?? input.meta.webPort;
      const appPort = Number(proxy.port);
      if (str(svc.network_mode) === "host") {
        if (hostPort && appPort && hostPort !== appPort) c.warn(`${input.meta.name} answered on port ${hostPort} through Umbrel, but it uses the server's network directly, so the copy answers on ${appPort}.`);
        unguarded = appPort || null;
      } else if (hostPort && appPort) {
        unguarded = hostPort;
        const list = Array.isArray(svc.ports) ? [...(svc.ports as unknown[])] : [];
        if (!publishedPorts(name, list, known).some((p) => p.host === hostPort && p.proto === "tcp")) list.push(`${hostPort}:${appPort}`);
        svc.ports = list;
      }
      proxy = { ...proxy, host: null };
    }
    ports.push(...publishedPorts(name, svc.ports, known));
  }
  if (proxy?.host) c.warn(`Gluon couldn't tell which part of ${input.meta.name} Umbrel's proxy forwarded to (${proxy.host}), so its web page isn't published. Add the port to the compose file after the move.`);
  if (proxy?.auth && unguarded) {
    c.warn(`Umbrel asked for its login before opening ${input.meta.name} on port ${unguarded}. The copy answers on port ${unguarded} directly, so anyone on your home network can open it without that login; only ${input.meta.name}'s own login, if it has one, protects it.`);
  }
  if (umbrel && input.umbrel?.hooks.length) c.warn(`Umbrel runs ${input.umbrel.hooks.map((h) => `hooks/${h}`).join(" and ")} around this app. Gluon doesn't, so check that the copy starts and works.`);

  // Top-level volumes: drop the ones that became folders.
  for (const k of Object.keys(topVolumes)) if (!usedTopVolumes.has(k) && !Object.values(services).some((s) => usesVolume(s, k))) delete topVolumes[k];
  if (Object.keys(topVolumes).length) doc.volumes = topVolumes;
  else delete doc.volumes;
  if (topNetworks.default === null) delete topNetworks.default; // Compose makes it anyway
  if (Object.keys(topNetworks).length) doc.networks = topNetworks;
  else delete doc.networks;

  // configs and secrets read from files.
  for (const section of ["configs", "secrets"] as const) {
    const s = doc[section];
    if (!isObj(s)) continue;
    for (const [k, def] of Object.entries(s)) {
      if (!isObj(def) || !str(def.file)) continue;
      const r = interpolate(str(def.file)!, known);
      const abs = r.missing.length ? null : resolveFrom(r.value, input.workingDir);
      if (!abs) {
        c.block(`Gluon couldn't place the file for ${section.slice(0, -1)} “${k}”.`);
        continue;
      }
      const own = input.ownDirs.find((d) => within(abs, d.path));
      if (own) {
        const dest = norm(path.posix.join(input.newDir, own.to, path.posix.relative(own.path, abs)))!;
        c.copy(abs, dest, "file", k);
        def.file = relativeTo(input.newDir, dest);
      } else {
        def.file = abs;
        c.stay(abs, k, true);
      }
    }
  }

  delete doc.version;
  delete doc["x-casaos"];
  delete doc["x-umbrel"];
  for (const svc of Object.values(services)) if (isObj(svc)) delete svc["x-casaos"];
  const out: Obj = { name: input.newProject };
  for (const [k, v] of Object.entries(doc)) if (k !== "name") out[k] = v;
  out["x-gluon"] = gluonMeta(input.meta, input.source, input.appId);

  const compose = render(out, `${input.meta.name}, moved to Gluon from ${sourceWord(input.source)}.`);
  const missing = interpolate(compose, forNew).missing;
  if (missing.length) c.block(`Gluon couldn't work out ${[...new Set(missing)].join(", ")}, which the compose file needs.`);
  const needed: Record<string, string> = {};
  for (const v of varsIn(compose)) if (forNew[v] !== undefined) needed[v] = forNew[v]!;

  return {
    compose,
    envText: envFor(needed, input.dotenvText ?? null),
    copies: c.finalCopies(),
    stays: [...c.stays.values()],
    sharedVolumes: [...c.shared],
    ports: dedupePorts(ports),
    loginLostPort: proxy?.auth && unguarded ? unguarded : null,
    warnings: c.warnings,
    blockers: c.blockers,
  };
}

function usesVolume(svc: unknown, key: string): boolean {
  if (!isObj(svc) || !Array.isArray(svc.volumes)) return false;
  return (svc.volumes as unknown[]).some((v) => parseVolume(v)?.source === key);
}

/** environment as [key, template] pairs, from a map or a KEY=value list. */
export function envEntries(env: unknown): [string, string | null][] {
  if (Array.isArray(env)) {
    return env.map((e) => {
      const s = String(e);
      const i = s.indexOf("=");
      return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
    });
  }
  if (isObj(env)) return Object.entries(env).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]);
  return [];
}

export function dedupePorts(ports: MovePort[]): MovePort[] {
  const seen = new Set<string>();
  return ports.filter((p) => {
    const k = `${p.host}/${p.proto}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const sourceWord = (s: MoveSource) => ({ umbrel: "Umbrel", casaos: "CasaOS", compose: "its compose folder", docker: "a single container" })[s];

export function gluonMeta(meta: AppMeta, source: MoveSource, id: string): Obj {
  const out: Obj = { name: meta.name };
  if (meta.icon) out.icon = meta.icon;
  if (meta.description) out.description = meta.description;
  if (meta.webPort) out.port = meta.webPort;
  if (meta.path && meta.path !== "/") out.path = meta.path;
  out.moved_from = { source, id };
  return out;
}

/** YAML out, with every port mapping quoted (YAML 1.1 readers turn 22:22 into a number). */
export function render(obj: Obj, title: string): string {
  const d = new YAML.Document(obj);
  YAML.visit(d, {
    Pair(_, pair) {
      if (YAML.isScalar(pair.key) && pair.key.value === "ports" && YAML.isSeq(pair.value)) {
        for (const it of pair.value.items) if (YAML.isScalar(it) && typeof it.value === "string") it.type = YAML.Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return `# ${title.replace(/\n/g, " ")}\n# Gluon runs this app from this folder with docker compose.\n${d.toString({ lineWidth: 0 })}`;
}

function envFor(vars: Record<string, string>, dotenv: string | null): string | null {
  const keys = Object.keys(vars);
  if (dotenv === null && !keys.length) return null;
  const lines: string[] = [];
  const present = new Set<string>();
  if (dotenv !== null) {
    for (const l of dotenv.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(l);
      if (m) present.add(m[1]!);
    }
  }
  for (const k of keys.sort()) {
    if (present.has(k)) continue;
    lines.push(envLine(k, vars[k]!));
  }
  const added = lines.length ? `# Added by Gluon when it moved this app.\n${lines.join("\n")}\n` : "";
  if (dotenv === null) return added;
  return `${dotenv.replace(/\s*$/, "\n")}${added}`;
}
