/**
 * The builder's compose model. The compose text is the source of truth: the form reads a projection
 * of each service from the YAML document and writes its edits back into the same document, so keys
 * the form doesn't know about (labels, cap_add, comments…) survive every edit.
 *
 * Isomorphic: used by the editor in the browser and by the server when it checks and publishes.
 */
import { Document, LineCounter, Scalar, YAMLMap, YAMLSeq, isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";
import type { Issue } from "@/lib/builder-types";
import { shellJoin, shellSplit } from "./names";

export interface ParsedCompose {
  doc: Document;
  lines: LineCounter;
  /** YAML syntax problems, with line numbers. */
  issues: Issue[];
  ok: boolean;
}

const YAML_WORDS: Record<string, string> = {
  BAD_INDENT: "The indentation is off",
  DUPLICATE_KEY: "This key appears twice",
  MULTILINE_IMPLICIT_KEY: "A key can't span lines; is a colon or indent missing?",
  MISSING_CHAR: "Something is missing here (a quote, bracket or colon)",
  BLOCK_AS_IMPLICIT_KEY: "A list or map can't be used as a key",
  TAB_AS_INDENT: "Tabs can't indent YAML; use spaces",
  BAD_SCALAR_START: "A value can't start with this character; put it in quotes",
  ALIAS_PROPS: "Anchors and aliases are used in a way YAML doesn't allow",
  UNEXPECTED_TOKEN: "Unexpected text here",
};

export const PARSE_OPTIONS = { maxAliasCount: 50, uniqueKeys: true, prettyErrors: false, strict: true, merge: true } as const;

export function parseCompose(text: string): ParsedCompose {
  const lines = new LineCounter();
  const doc = parseDocument(text, { ...PARSE_OPTIONS, lineCounter: lines });
  const issues: Issue[] = [];
  doc.errors.forEach((e, i) => {
    const line = e.linePos?.[0]?.line;
    const words = YAML_WORDS[e.code] ?? e.message.split(/ at line \d+/)[0]!.split("\n")[0]!;
    issues.push({ id: `yaml-${i}`, level: "error", message: line ? `Line ${line}: ${words}.` : `${words}.`, line });
  });
  return { doc, lines, issues, ok: issues.length === 0 };
}

export const stringify = (doc: Document) => doc.toString({ lineWidth: 0, indent: 2, indentSeq: true });

// ---------------------------------------------------------------- reading helpers

export function scalarText(n: unknown): string | null {
  if (isScalar(n)) return n.value === null || n.value === undefined ? "" : String(n.value);
  if (typeof n === "string" || typeof n === "number" || typeof n === "boolean") return String(n);
  return null;
}

export function lineOf(node: unknown, lines: LineCounter): number | undefined {
  const r = (node as Node | undefined)?.range;
  return r ? lines.linePos(r[0]).line : undefined;
}

export function servicesMap(doc: Document): YAMLMap | null {
  const s = doc.get("services", true);
  return isMap(s) ? s : null;
}

export function serviceNames(doc: Document): string[] {
  const m = servicesMap(doc);
  if (!m) return [];
  return m.items.map((p) => scalarText(p.key) ?? "").filter(Boolean);
}

export function serviceNode(doc: Document, name: string): YAMLMap | null {
  const n = servicesMap(doc)?.get(name, true);
  return isMap(n) ? n : null;
}

/** A node as plain JS, with aliases and `<<` merge keys resolved against its document. */
export function nodeJs<T = unknown>(node: unknown, doc: Document): T {
  if (node && typeof node === "object" && "toJS" in node) return (node as { toJS: (d: Document) => T }).toJS(doc);
  return node as T;
}

/** A plain JS view of one service, merges resolved (for reads that don't need positions). */
export function serviceJs(doc: Document, name: string): Record<string, unknown> {
  const n = serviceNode(doc, name);
  const v = n ? nodeJs<Record<string, unknown> | null>(n, doc) : null;
  return v && typeof v === "object" ? v : {};
}

// ---------------------------------------------------------------- the form's projection

export interface PortRow {
  host: number | null;
  container: number | null;
  proto: "tcp" | "udp";
  /** Bind address, e.g. 127.0.0.1. Empty for all addresses. */
  ip: string;
  /** Set when the entry is something the form can't edit (ranges, variables); shown read-only. */
  raw: string | null;
}

export type VolumeKind = "data" | "host" | "named" | "relative" | "other";

export interface VolumeRow {
  kind: VolumeKind;
  /** data: folder under data/ ("config"); host: absolute path; named: volume name; relative: ./path. */
  source: string;
  target: string;
  readOnly: boolean;
  /** The entry as written when it's long syntax or something the form can't edit. */
  raw: string | null;
  long: boolean;
}

export interface EnvRow {
  key: string;
  value: string;
  /** The value uses compose variables (${X}); it is written back exactly as typed. */
  interpolated: boolean;
}

export interface HealthForm {
  test: string;
  interval: string;
  timeout: string;
  retries: string;
  startPeriod: string;
}

export interface LabelRow {
  key: string;
  value: string;
}

export interface ServiceForm {
  name: string;
  image: string;
  build: { context: string; dockerfile: string; target: string } | null;
  ports: PortRow[];
  volumes: VolumeRow[];
  env: EnvRow[];
  restart: string;
  command: string;
  user: string;
  devices: string[];
  hostNetwork: boolean;
  networkMode: string;
  memory: string;
  /** CPU limit in cores ("1.5"), from cpus: or deploy.resources.limits.cpus. */
  cpus: string;
  /** Reserves the NVIDIA GPU (deploy.resources.reservations.devices). */
  gpu: boolean;
  labels: LabelRow[];
  /** Networks it joins by name ("default" is the app's own). Empty: just the app's own. */
  networks: string[];
  health: HealthForm | null;
  healthDisabled: boolean;
  dependsOn: string[];
  containerName: string | null;
  privileged: boolean;
  /** Container paths waiting for the person to choose a server folder (media libraries). */
  pendingFolders: string[];
  /** Keys set in the compose file that the form doesn't show. */
  extraKeys: string[];
}

const MODELED = new Set([
  "image", "build", "ports", "volumes", "environment", "restart", "command", "user", "devices", "network_mode", "mem_limit",
  "healthcheck", "depends_on", "container_name", "privileged", "labels", "networks", "cpus",
]);

export const DATA_PREFIX = "${APP_DATA_DIR}/data/";
/**
 * Media folders Gluon won't guess (app data is deleted with the app) wait under this extension
 * key until the person chooses a server folder. Compose ignores x- keys, so the file stays
 * valid and nothing is mounted until then; the checks block starting while any are left.
 */
export const PENDING_KEY = "x-gluon-choose-folder";
const DATA_PREFIX_RE = /^\$\{?APP_DATA_DIR\}?\/data\/(.+)$/;
const DATA_ROOT_RE = /^\$\{?APP_DATA_DIR\}?(\/.*)?$/;

export const unescapeDollars = (v: string) => v.replace(/\$\$/g, "$");
export const escapeDollars = (v: string) => v.replace(/\$/g, "$$$$");
/** A single `$` that isn't `$$`: compose will substitute a variable here. */
export const hasInterpolation = (v: string) => /(^|[^$])\$(?!\$)/.test(v.replace(/\$\$/g, ""));

export function parsePortString(s: string): PortRow {
  const raw = s.trim();
  const bad: PortRow = { host: null, container: null, proto: "tcp", ip: "", raw };
  let rest = raw;
  let proto: "tcp" | "udp" = "tcp";
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    const p = rest.slice(slash + 1).toLowerCase();
    if (p !== "tcp" && p !== "udp") return bad;
    proto = p;
    rest = rest.slice(0, slash);
  }
  let ip = "";
  const v6 = /^\[([^\]]+)\]:(.*)$/.exec(rest);
  if (v6) {
    ip = v6[1]!;
    rest = v6[2]!;
  }
  const parts = rest.split(":");
  if (!v6 && parts.length === 3) {
    ip = parts.shift()!;
  }
  if (parts.length > 2 || parts.some((p) => !/^\d{1,5}$/.test(p))) return bad;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 1 || n > 65535)) return bad;
  if (nums.length === 1) return { host: null, container: nums[0]!, proto, ip, raw: null };
  return { host: nums[0]!, container: nums[1]!, proto, ip, raw: null };
}

export function portString(r: PortRow): string {
  if (r.raw !== null) return r.raw;
  const ip = r.ip ? (r.ip.includes(":") ? `[${r.ip}]:` : `${r.ip}:`) : "";
  const base = r.host ? `${ip}${r.host}:${r.container}` : `${r.container}`;
  return r.proto === "udp" ? `${base}/udp` : base;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function readPort(v: unknown): PortRow {
  if (isObj(v)) {
    const container = Number(v.target);
    const host = v.published === undefined || v.published === null || v.published === "" ? null : Number(v.published);
    const proto = String(v.protocol ?? "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    const ok = Number.isInteger(container) && container > 0 && container < 65536 && (host === null || (Number.isInteger(host) && host > 0 && host < 65536));
    return ok ? { host, container, proto, ip: typeof v.host_ip === "string" ? v.host_ip : "", raw: null } : { host: null, container: null, proto, ip: "", raw: JSON.stringify(v) };
  }
  return parsePortString(text(v));
}

export function parseVolumeString(s: string): VolumeRow {
  const raw = s.trim();
  // host:container[:mode]; Windows drive letters aren't a thing here.
  const parts = raw.split(":");
  if (parts.length === 1) return { kind: "other", source: "", target: parts[0]!, readOnly: false, raw, long: false };
  const [source, target, mode] = parts as [string, string, string | undefined];
  if (parts.length > 3 || !target) return { kind: "other", source, target: target ?? "", readOnly: false, raw, long: false };
  const readOnly = !!mode && mode.split(",").includes("ro");
  const extraMode = !!mode && mode.split(",").some((m) => m !== "ro" && m !== "rw");
  const data = DATA_PREFIX_RE.exec(source);
  let row: VolumeRow;
  if (data) row = { kind: "data", source: data[1]!.replace(/\/$/, ""), target, readOnly, raw: null, long: false };
  else if (DATA_ROOT_RE.test(source)) row = { kind: "other", source, target, readOnly, raw, long: false };
  else if (source.startsWith("/")) row = { kind: "host", source, target, readOnly, raw: null, long: false };
  else if (source.startsWith(".") || source.startsWith("~")) row = { kind: "relative", source, target, readOnly, raw: null, long: false };
  else if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) row = { kind: "named", source, target, readOnly, raw: null, long: false };
  else row = { kind: "other", source, target, readOnly, raw, long: false };
  if (extraMode) row.raw = raw;
  return row;
}

export function volumeString(r: VolumeRow): string {
  if (r.raw !== null && !r.long) return r.raw;
  const src = r.kind === "data" ? `${DATA_PREFIX}${r.source}` : r.source;
  return `${src}:${r.target}${r.readOnly ? ":ro" : ""}`;
}

function readVolume(v: unknown): VolumeRow {
  if (isObj(v)) {
    const type = String(v.type ?? "volume");
    const source = typeof v.source === "string" ? v.source : "";
    const target = typeof v.target === "string" ? v.target : "";
    const readOnly = v.read_only === true;
    if ((type === "bind" || type === "volume") && source && target) {
      const row = parseVolumeString(`${source}:${target}${readOnly ? ":ro" : ""}`);
      return { ...row, long: true, raw: row.raw ?? JSON.stringify(v) };
    }
    return { kind: "other", source, target, readOnly, raw: JSON.stringify(v), long: true };
  }
  return parseVolumeString(text(v));
}

function readEnv(v: unknown): EnvRow[] {
  const out: EnvRow[] = [];
  const push = (key: string, rawValue: string) => {
    const interpolated = hasInterpolation(rawValue);
    out.push({ key, value: interpolated ? rawValue : unescapeDollars(rawValue), interpolated });
  };
  if (isObj(v)) for (const [k, val] of Object.entries(v)) push(k, text(val));
  else if (Array.isArray(v)) {
    for (const it of v) {
      const s = text(it);
      const eq = s.indexOf("=");
      if (eq > 0) push(s.slice(0, eq), s.slice(eq + 1));
      else if (s) push(s, "");
    }
  }
  return out;
}

function readCommand(v: unknown): string {
  if (Array.isArray(v)) return shellJoin(v.map(text));
  return text(v);
}

function readLabels(v: unknown): LabelRow[] {
  if (isObj(v)) return Object.entries(v).map(([key, val]) => ({ key, value: text(val) }));
  if (Array.isArray(v))
    return v.map(text).map((s) => {
      const eq = s.indexOf("=");
      return eq > 0 ? { key: s.slice(0, eq), value: s.slice(eq + 1) } : { key: s, value: "" };
    });
  return [];
}

const isGpuDevice = (d: unknown) =>
  isObj(d) && (String(d.driver ?? "").toLowerCase() === "nvidia" || (Array.isArray(d.capabilities) && d.capabilities.map(String).includes("gpu")));

type DeployShape = { resources?: { limits?: { memory?: unknown; cpus?: unknown }; reservations?: { devices?: unknown[] } } };

/** deploy: holds only what the form shows (memory, CPU, the GPU), so it isn't an "also set" key. */
function deployIsModeled(d: unknown): boolean {
  if (!isObj(d)) return d === undefined || d === null;
  const only = (o: unknown, keys: string[]) => isObj(o) && Object.keys(o).every((k) => keys.includes(k));
  if (!only(d, ["resources"])) return false;
  const r = d.resources;
  if (r === undefined) return true;
  if (!only(r, ["limits", "reservations"])) return false;
  const res = r as Record<string, unknown>;
  if (res.limits !== undefined && !only(res.limits, ["memory", "cpus"])) return false;
  if (res.reservations !== undefined) {
    if (!only(res.reservations, ["devices"])) return false;
    const devs = (res.reservations as Record<string, unknown>).devices;
    if (devs !== undefined && !(Array.isArray(devs) && devs.every(isGpuDevice))) return false;
  }
  return true;
}

function readHealth(v: unknown): { health: HealthForm | null; disabled: boolean } {
  if (!isObj(v)) return { health: null, disabled: false };
  if (v.disable === true) return { health: null, disabled: true };
  let test = "";
  if (Array.isArray(v.test)) {
    const [kind, ...rest] = v.test.map(String);
    if (kind === "NONE") return { health: null, disabled: true };
    test = kind === "CMD-SHELL" ? rest.join(" ") : kind === "CMD" ? shellJoin(rest) : shellJoin([kind!, ...rest]);
  } else if (typeof v.test === "string") test = v.test;
  return { health: { test, interval: text(v.interval), timeout: text(v.timeout), retries: text(v.retries), startPeriod: text(v.start_period) }, disabled: false };
}

/** The form's view of one service. Reads merge-resolved values, so `<<: *defaults` services show fully. */
export function readService(doc: Document, name: string): ServiceForm {
  const o = serviceJs(doc, name);
  let build: ServiceForm["build"] = null;
  if (typeof o.build === "string") build = { context: o.build || ".", dockerfile: "", target: "" };
  else if (isObj(o.build)) {
    const b = o.build;
    build = { context: typeof b.context === "string" ? b.context : ".", dockerfile: typeof b.dockerfile === "string" ? b.dockerfile : "", target: typeof b.target === "string" ? b.target : "" };
  }
  let dependsOn: string[] = [];
  if (Array.isArray(o.depends_on)) dependsOn = o.depends_on.map(text).filter(Boolean);
  else if (isObj(o.depends_on)) dependsOn = Object.keys(o.depends_on);
  const networkMode = text(o.network_mode);
  const deploy = (isObj(o.deploy) ? o.deploy : {}) as DeployShape;
  let memory = text(o.mem_limit);
  if (!memory) {
    const m = deploy.resources?.limits?.memory;
    if (typeof m === "string" || typeof m === "number") memory = String(m);
  }
  let cpus = text(o.cpus);
  if (!cpus) {
    const c = deploy.resources?.limits?.cpus;
    if (typeof c === "string" || typeof c === "number") cpus = String(c);
  }
  const devs = deploy.resources?.reservations?.devices;
  const gpu = Array.isArray(devs) && devs.some(isGpuDevice);
  let networks: string[] = [];
  if (Array.isArray(o.networks)) networks = o.networks.map(text).filter(Boolean);
  else if (isObj(o.networks)) networks = Object.keys(o.networks);
  const { health, disabled } = readHealth(o.healthcheck);
  return {
    name,
    image: text(o.image),
    build,
    ports: Array.isArray(o.ports) ? o.ports.map(readPort) : [],
    volumes: Array.isArray(o.volumes) ? o.volumes.map(readVolume) : [],
    env: readEnv(o.environment),
    restart: text(o.restart),
    command: readCommand(o.command),
    user: text(o.user),
    devices: Array.isArray(o.devices) ? o.devices.map(text).filter(Boolean) : [],
    hostNetwork: networkMode === "host",
    networkMode,
    memory,
    cpus,
    gpu,
    labels: readLabels(o.labels),
    networks,
    health,
    healthDisabled: disabled,
    dependsOn,
    containerName: o.container_name ? text(o.container_name) : null,
    privileged: o.privileged === true || o.privileged === "true",
    pendingFolders: Array.isArray(o[PENDING_KEY]) ? (o[PENDING_KEY] as unknown[]).map(text).filter((t) => t.startsWith("/")) : [],
    extraKeys: Object.keys(o).filter((k) => k !== "<<" && k !== PENDING_KEY && !MODELED.has(k) && !(k === "deploy" && deployIsModeled(o.deploy))),
  };
}

export function readServices(doc: Document): ServiceForm[] {
  return serviceNames(doc).map((n) => readService(doc, n));
}

// ---------------------------------------------------------------- writing (edits in place)

function ensureServices(doc: Document): YAMLMap {
  let m = servicesMap(doc);
  if (!m) {
    if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
    doc.set("services", doc.createNode({}));
    m = servicesMap(doc)!;
  }
  return m;
}

function quoted(doc: Document, v: string): Scalar {
  const s = doc.createNode(v) as Scalar;
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

/** Set, or delete when empty, one key of a service. */
function setKey(doc: Document, service: string, key: string, value: unknown) {
  const n = serviceNode(doc, service);
  if (!n) return;
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) n.delete(key);
  else n.set(key, value instanceof Scalar || isSeq(value) || isMap(value) ? value : doc.createNode(value));
}

export function setImage(doc: Document, service: string, image: string) {
  setKey(doc, service, "image", image.trim());
}

export function setRestart(doc: Document, service: string, restart: string) {
  setKey(doc, service, "restart", restart);
}

export function setUser(doc: Document, service: string, user: string) {
  setKey(doc, service, "user", user.trim() ? quoted(doc, user.trim()) : "");
}

export function setCommand(doc: Document, service: string, command: string) {
  const n = serviceNode(doc, service);
  const wasList = isSeq(n?.get("command", true));
  if (!command.trim()) return setKey(doc, service, "command", "");
  setKey(doc, service, "command", wasList ? doc.createNode(shellSplit(command)) : command);
}

export function setMemory(doc: Document, service: string, memory: string) {
  const n = serviceNode(doc, service);
  if (n) {
    n.deleteIn(["deploy", "resources", "limits", "memory"]);
    pruneDeploy(n);
  }
  setKey(doc, service, "mem_limit", memory.trim().toLowerCase().replace(/\s+/g, ""));
}

/** Remove empty maps left behind under deploy: after a nested delete. */
function pruneDeploy(n: YAMLMap) {
  for (const path of [["deploy", "resources", "limits"], ["deploy", "resources", "reservations"], ["deploy", "resources"], ["deploy"]]) {
    const v = n.getIn(path, true);
    if (isMap(v) && v.items.length === 0) n.deleteIn(path);
    if (isSeq(v) && v.items.length === 0) n.deleteIn(path);
  }
}

export function setCpus(doc: Document, service: string, cpus: string) {
  const n = serviceNode(doc, service);
  if (!n) return;
  n.deleteIn(["deploy", "resources", "limits", "cpus"]);
  pruneDeploy(n);
  const t = cpus.trim();
  setKey(doc, service, "cpus", t && /^\d+(\.\d+)?$/.test(t) ? Number(t) : t);
}

/** Reserve every NVIDIA GPU for the service (compose's equivalent of docker run --gpus all). */
export function setGpu(doc: Document, service: string, on: boolean) {
  const n = serviceNode(doc, service);
  if (!n) return;
  const path = ["deploy", "resources", "reservations", "devices"];
  const old = n.getIn(path, true);
  const kept = isSeq(old) ? old.items.filter((d) => !isGpuDevice(nodeJs(d, doc))) : [];
  if (on) {
    const seq = new YAMLSeq();
    seq.items.push(...kept, doc.createNode({ driver: "nvidia", count: "all", capabilities: ["gpu"] }));
    n.setIn(path, seq);
  } else if (kept.length) {
    const seq = new YAMLSeq();
    seq.items.push(...kept);
    n.setIn(path, seq);
  } else {
    n.deleteIn(path);
    pruneDeploy(n);
  }
}

export function setLabels(doc: Document, service: string, rows: LabelRow[]) {
  const map = new YAMLMap();
  for (const r of rows) if (r.key) map.set(doc.createNode(r.key), quoted(doc, r.value));
  setKey(doc, service, "labels", map.items.length ? map : "");
}

export interface NetworkDecl {
  name: string;
  /** Made by someone else (external: true); compose only joins it. */
  external: boolean;
}

/** Networks declared at the top of the file. */
export function readNetworks(doc: Document): NetworkDecl[] {
  const top = doc.get("networks", true);
  if (!isMap(top)) return [];
  return top.items.map((p) => {
    const v = nodeJs<Record<string, unknown> | null>(p.value, doc);
    return { name: scalarText(p.key) ?? "", external: !!v && (v.external === true || isObj(v.external)) };
  }).filter((n) => n.name);
}

/**
 * Which networks a service joins. Joining any named network means compose no longer adds the
 * app's own network by itself, so "default" stays in the list unless the person removes it.
 * Existing settings per network (aliases, addresses) survive.
 */
export function setServiceNetworks(doc: Document, service: string, names: string[], external: string[] = []) {
  const n = serviceNode(doc, service);
  if (!n) return;
  const uniq = [...new Set(names.filter(Boolean))];
  const old = n.get("networks", true);
  if (!uniq.length || (uniq.length === 1 && uniq[0] === "default" && !isMap(old))) n.delete("networks");
  else if (isMap(old)) {
    const map = new YAMLMap();
    for (const name of uniq) map.set(doc.createNode(name), (old.get(name, true) as Node | undefined) ?? null);
    n.set("networks", map);
  } else n.set("networks", doc.createNode(uniq));
  for (const name of uniq) if (name !== "default") declareNetwork(doc, name, external.includes(name));
  dropUnusedNetworks(doc);
}

export function declareNetwork(doc: Document, name: string, external: boolean) {
  let top = doc.get("networks", true);
  if (!isMap(top)) {
    doc.set("networks", doc.createNode({}));
    top = doc.get("networks", true);
  }
  const m = top as YAMLMap;
  if (m.has(name)) return;
  m.set(doc.createNode(name), external ? doc.createNode({ external: true }) : doc.createNode({}));
}

function dropUnusedNetworks(doc: Document) {
  const top = doc.get("networks", true);
  if (!isMap(top)) return;
  const used = new Set<string>();
  for (const s of serviceNames(doc)) for (const net of readService(doc, s).networks) used.add(net);
  for (const p of [...top.items]) {
    const k = scalarText(p.key) ?? "";
    if (k !== "default" && !used.has(k)) top.delete(k);
  }
  if (top.items.length === 0) doc.delete("networks");
}

export function setHostNetwork(doc: Document, service: string, on: boolean) {
  const n = serviceNode(doc, service);
  if (!n) return;
  if (on) {
    n.set("network_mode", "host");
    n.delete("networks");
    dropUnusedNetworks(doc);
  } else if (scalarText(n.get("network_mode", true)) === "host") n.delete("network_mode");
}

export function setPrivileged(doc: Document, service: string, on: boolean) {
  setKey(doc, service, "privileged", on ? true : "");
}

export function setPorts(doc: Document, service: string, rows: PortRow[]) {
  const seq = new YAMLSeq();
  for (const r of rows) seq.items.push(quoted(doc, portString(r)));
  setKey(doc, service, "ports", rows.length ? seq : "");
}

export function setVolumes(doc: Document, service: string, rows: VolumeRow[]) {
  const n = serviceNode(doc, service);
  const old = n?.get("volumes", true);
  const seq = new YAMLSeq();
  rows.forEach((r, i) => {
    // Long entries the form couldn't edit stay exactly as they were.
    const before = isSeq(old) ? old.items[i] : undefined;
    if (r.raw !== null && r.long && before && isMap(before) && JSON.stringify(nodeJs(before, doc)) === r.raw) seq.items.push(before as YAMLMap);
    else seq.items.push(doc.createNode(volumeString({ ...r, raw: r.long ? null : r.raw })));
  });
  setKey(doc, service, "volumes", rows.length ? seq : "");
}

export function setEnv(doc: Document, service: string, rows: EnvRow[]) {
  const map = new YAMLMap();
  for (const r of rows) {
    if (!r.key) continue;
    const v = r.interpolated ? r.value : escapeDollars(r.value);
    map.set(doc.createNode(r.key), doc.createNode(v));
  }
  setKey(doc, service, "environment", map.items.length ? map : "");
}

export function setPendingFolders(doc: Document, service: string, targets: string[]) {
  setKey(doc, service, PENDING_KEY, [...new Set(targets)]);
}

/** Mount a server folder at a pending target, and stop waiting for it. */
export function choosePendingFolder(doc: Document, service: string, target: string, hostPath: string) {
  const f = readService(doc, service);
  setVolumes(doc, service, [...f.volumes, { kind: "host", source: hostPath, target, readOnly: false, raw: null, long: false }]);
  setPendingFolders(doc, service, f.pendingFolders.filter((t) => t !== target));
}

export function setDevices(doc: Document, service: string, devices: string[]) {
  setKey(doc, service, "devices", devices.filter(Boolean));
}

export function setDependsOn(doc: Document, service: string, deps: string[]) {
  const n = serviceNode(doc, service);
  const old = n?.get("depends_on", true);
  if (isMap(old)) {
    // Keep conditions (service_healthy…) for services that stay.
    const map = new YAMLMap();
    for (const d of deps) map.set(doc.createNode(d), (old.get(d, true) as Node | undefined) ?? doc.createNode({ condition: "service_started" }));
    setKey(doc, service, "depends_on", deps.length ? map : "");
  } else setKey(doc, service, "depends_on", deps);
}

export function setHealth(doc: Document, service: string, h: HealthForm | null, disabled = false) {
  if (disabled) return setKey(doc, service, "healthcheck", doc.createNode({ disable: true }));
  const timings = !!h && [h.interval, h.timeout, h.retries, h.startPeriod].some((x) => x.trim());
  if (!h || (!h.test.trim() && !timings)) return setKey(doc, service, "healthcheck", "");
  // Without a test, compose keeps the image's own check and changes only its timing.
  const o: Record<string, unknown> = h.test.trim() ? { test: ["CMD-SHELL", h.test.trim()] } : {};
  if (h.interval.trim()) o.interval = h.interval.trim();
  if (h.timeout.trim()) o.timeout = h.timeout.trim();
  if (h.retries.trim() && /^\d+$/.test(h.retries.trim())) o.retries = Number(h.retries.trim());
  if (h.startPeriod.trim()) o.start_period = h.startPeriod.trim();
  setKey(doc, service, "healthcheck", doc.createNode(o));
}

export function setBuild(doc: Document, service: string, build: { context: string; dockerfile: string; target: string } | null) {
  if (!build) return setKey(doc, service, "build", "");
  const o: Record<string, string> = { context: build.context || "." };
  if (build.dockerfile) o.dockerfile = build.dockerfile;
  if (build.target) o.target = build.target;
  setKey(doc, service, "build", Object.keys(o).length === 1 ? o.context : doc.createNode(o));
}

export function addService(doc: Document, name: string, init: Record<string, unknown> = {}) {
  const m = ensureServices(doc);
  m.set(doc.createNode(name), doc.createNode({ image: "", restart: "unless-stopped", ...init }));
}

export function removeService(doc: Document, name: string) {
  const m = servicesMap(doc);
  if (!m) return;
  m.delete(name);
  for (const other of serviceNames(doc)) {
    const f = readService(doc, other);
    if (f.dependsOn.includes(name)) setDependsOn(doc, other, f.dependsOn.filter((d) => d !== name));
  }
}

export function renameService(doc: Document, from: string, to: string) {
  const m = servicesMap(doc);
  if (!m || from === to) return;
  const pair = m.items.find((p) => scalarText(p.key) === from) as Pair<Scalar, unknown> | undefined;
  if (!pair) return;
  pair.key = doc.createNode(to) as Scalar;
  for (const other of serviceNames(doc)) {
    const f = readService(doc, other);
    if (f.dependsOn.includes(from)) setDependsOn(doc, other, f.dependsOn.map((d) => (d === from ? to : d)));
  }
}

/** A fresh one-service compose document. */
export function newCompose(service = "app", image = ""): string {
  const doc = new Document({ services: { [service]: { image, restart: "unless-stopped" } } });
  return stringify(doc);
}

/** Compose variables a text uses (`${NAME}`, `${NAME:-default}`, `$NAME`), excluding escaped `$$`. */
export function variablesIn(text: string): { name: string; hasDefault: boolean }[] {
  const out = new Map<string, boolean>();
  const t = text.replace(/\$\$/g, "");
  const re = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const name = m[1] ?? m[3]!;
    const hasDefault = !!m[2] && /^:?[-+]/.test(m[2]);
    out.set(name, (out.get(name) ?? true) && hasDefault);
  }
  return [...out].map(([name, hasDefault]) => ({ name, hasDefault }));
}

export { isMap, isSeq, isScalar, isPair };
