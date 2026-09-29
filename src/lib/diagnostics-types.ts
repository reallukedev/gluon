/** Types shared between the Diagnostics API and the client. No server imports. */

// ---------------------------------------------------------------- throughput

export interface InterfaceInfo {
  name: string;
  kind: "ethernet" | "wireless" | "bridge" | "veth" | "loopback" | "vpn" | "other";
  /** Docker network name for docker0 / br-* bridges. */
  dockerNetwork: string | null;
  state: string; // UP | DOWN | UNKNOWN …
  mtu: number | null;
  mac: string | null;
  speedMbps: number | null;
  addresses: { family: "inet" | "inet6"; address: string; prefix: number; scope: string }[];
  rxTotal: number;
  txTotal: number;
  rxErrors: number;
  txErrors: number;
  /** Counted in the machine's total (not loopback, bridges or veths). */
  physical: boolean;
}

// ---------------------------------------------------------------- connections

export type Owner =
  | { kind: "container"; id: string; name: string; appId: string | null; appName: string | null }
  | { kind: "service"; unit: string }
  | { kind: "process" }
  | { kind: "unknown" };

export type AddrScope = "local" | "containers" | "lan" | "internet";

export interface Connection {
  proto: "tcp" | "udp";
  local: { ip: string; port: number };
  remote: { ip: string; port: number; host: string | null; scope: AddrScope; container: string | null };
  /** in = someone connected to a listening port here; out = this machine connected out. */
  direction: "in" | "out";
  process: { pid: number; name: string } | null;
  owner: Owner;
  /** Human label for the owner: app name, container, unit or process. */
  ownerLabel: string;
  netns: "host" | "container";
  recvQ: number;
  sendQ: number;
}

export interface ConnectionsSnapshot {
  t: number;
  connections: Connection[];
  counts: { total: number; inbound: number; outbound: number; internet: number; lan: number; containers: number; hiddenLocal: number };
  topRemotes: { ip: string; host: string | null; scope: AddrScope; count: number; owners: string[] }[];
  topOwners: { label: string; inbound: number; outbound: number; total: number }[];
  truncated: boolean;
}

// ---------------------------------------------------------------- requests (Caddy access log)

export interface RequestEntry {
  id: number;
  time: number;
  host: string;
  method: string;
  uri: string;
  status: number;
  /** Milliseconds. */
  duration: number;
  size: number;
  remoteIp: string;
  userAgent: string;
  proto: string | null;
  country: null;
  /** Health checks from Gluon/Domains and requests from containers on this machine. */
  internal: boolean;
}

export interface CaddyNotice {
  time: number;
  level: string;
  logger: string;
  message: string;
  host: string | null;
}

export interface RequestStats {
  t: number;
  windowMinutes: number;
  total: number;
  perMinute: number;
  errorRate: number; // 5xx share, 0..1
  clientErrorRate: number; // 4xx share, 0..1
  avgMs: number | null;
  p95Ms: number | null;
  bytes: number;
  internalExcluded: number;
  statusClasses: Record<"2xx" | "3xx" | "4xx" | "5xx" | "other", number>;
  topPaths: { key: string; count: number; errors: number }[];
  topClients: { key: string; count: number; errors: number }[];
  topHosts: { key: string; count: number; errors: number }[];
  /** Last 60 minutes, oldest first: [minuteStartMs, requests, 5xx]. */
  series: [number, number, number][];
}

export interface RequestFeedState {
  following: boolean;
  container: string | null;
  error: string | null;
  /** The access log format Caddy is using: json (current), console (older Caddyfile), or none seen yet. */
  format: "json" | "console" | null;
}

// ---------------------------------------------------------------- processes

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  user: string;
  uid: number;
  state: string; // R S D Z T I …
  stateLabel: string;
  threads: number;
  /** % of the whole machine (all cores = 100). */
  cpu: number;
  /** % of one core, like top. */
  cpuCore: number;
  memBytes: number;
  memPct: number;
  startedAt: number | null;
  kernel: boolean;
  owner: Owner;
  ownerLabel: string;
}

export interface ProcessSnapshot {
  t: number;
  totals: { processes: number; threads: number; running: number; blocked: number; zombies: number };
  cores: number;
  memTotal: number;
  byCpu: ProcessInfo[];
  byMem: ProcessInfo[];
}

// ---------------------------------------------------------------- logs

export type LogLevel = "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";

export interface LogEntry {
  time: number;
  source: "kernel" | "journal" | "docker";
  level: LogLevel;
  message: string;
  unit: string | null;
  identifier: string | null;
  pid: number | null;
  cursor: string | null;
}

// ---------------------------------------------------------------- tools

export interface DnsToolResult {
  name: string;
  type: string;
  resolver: string;
  status: string; // NOERROR | NXDOMAIN | SERVFAIL | TIMEOUT …
  answers: { name: string; ttl: number; type: string; data: string }[];
  queryMs: number | null;
  server: string | null;
  message: string;
}

export interface PingToolResult {
  host: string;
  address: string | null;
  transmitted: number;
  received: number;
  lossPct: number;
  rtt: { min: number; avg: number; max: number; mdev: number } | null;
  replies: { seq: number; ttl: number | null; ms: number }[];
  message: string;
}

export interface PortToolResult {
  host: string;
  port: number;
  address: string | null;
  open: boolean;
  ms: number | null;
  error: string | null;
  message: string;
}

/** Milliseconds since the request started, when each phase finished (cumulative, like curl's -w timings). */
export interface HttpTiming {
  dns: number | null;
  connect: number | null;
  tls: number | null;
  ttfb: number | null;
  total: number | null;
}

export interface HttpHop {
  url: string;
  status: number | null;
  statusText: string | null;
  httpVersion: string | null;
  remoteAddress: string | null;
  headers: Record<string, string | string[]>;
  timing: HttpTiming;
  location: string | null;
  error: string | null;
}

export interface HttpToolResult {
  hops: HttpHop[];
  final: HttpHop | null;
  body: { text: string; truncated: boolean; contentType: string | null; binary: boolean } | null;
  tls: { protocol: string | null; cipher: string | null; subject: string | null; issuer: string | null; validTo: string | null; daysLeft: number | null; trusted: boolean; error: string | null } | null;
  message: string;
}

export interface TracerouteToolResult {
  available: boolean;
  tool: "traceroute" | "tracepath" | null;
  host: string;
  hops: { hop: number; address: string | null; host: string | null; ms: number[] }[];
  reached: boolean;
  message: string;
}

// ---------------------------------------------------------------- checkup

/** ok = passed, warn = worth a look, fail = broken, skip = couldn't or didn't need to check. */
export type CheckState = "ok" | "warn" | "fail" | "skip";

export type CheckupKind = "full" | "app" | "address" | "internet" | "server" | "space" | "drive" | "safety";

/** A fix offered next to a result: a server-side remedy (same as the ones on Status) or a place to go. */
export interface CheckFix {
  label: string;
  /** Registered remedy action ("apps.start"); empty when `href` is set. */
  action: string;
  params?: Record<string, unknown>;
  confirm?: { title: string; consequences: string[]; typeToConfirm?: string };
  href?: string;
  /** The open finding this fix came from, so running it is recorded against it. */
  findingId?: string | null;
}

export interface CheckResult {
  id: string;
  state: CheckState;
  /** A plain sentence of the result: "/var is 93% full". */
  title: string;
  /** Why it matters or what to do, in a sentence or two. */
  detail?: string | null;
  /** Short measured value for instruments ("12 ms", "240 Mb/s"). */
  value?: string | null;
  /** Raw numbers or command output behind the result, shown in a disclosure. */
  evidence?: string | null;
  fix?: CheckFix | null;
  /** How long the check took. */
  ms: number;
}

export interface CheckPlanItem {
  id: string;
  /** Group id (a category for full checkups, "path" for the hops of a probe path). */
  group: string;
  /** What is being checked, short: "DNS through 1.1.1.1". */
  label: string;
  /** A hop on the probe path (drawn as a node in order). */
  hop?: boolean;
  /** Secondary text under a hop: the address or port it probes. */
  sub?: string | null;
}

export interface CheckupGroup {
  id: string;
  label: string;
}

export interface CheckupMeta {
  id: string;
  kind: CheckupKind;
  target: string | null;
  /** "Full checkup", "Jellyfin won't open". */
  title: string;
  layout: "sweep" | "path";
  /** Path runs: where the path starts ("This server"). */
  origin: string | null;
  groups: CheckupGroup[];
  startedAt: number;
  startedBy: string | null;
}

export interface CheckupDiffItem {
  id: string;
  title: string;
  state: CheckState;
}

export interface CheckupSummary {
  status: "done" | "cancelled" | "failed";
  finishedAt: number;
  counts: Record<CheckState, number>;
  /** One sentence, state first: "Everything checks out." */
  verdict: string;
  /** Compared with the previous finished run of the same kind (and target). */
  diff: { previousId: string; previousAt: number; appeared: CheckupDiffItem[]; fixed: CheckupDiffItem[] } | null;
}

export interface CheckupRun {
  meta: CheckupMeta;
  plan: CheckPlanItem[];
  results: CheckResult[];
  summary: CheckupSummary | null;
}

export interface CheckupRunRow {
  id: string;
  kind: CheckupKind;
  target: string | null;
  title: string;
  startedAt: number;
  startedBy: string | null;
  finishedAt: number | null;
  status: CheckupSummary["status"] | "running";
  counts: Record<CheckState, number> | null;
  verdict: string | null;
}

export type CheckupEvent =
  | { type: "start"; meta: CheckupMeta; plan: CheckPlanItem[]; results: CheckResult[]; running: string[]; attached: boolean }
  /** A check started probing. */
  | { type: "begin"; id: string }
  | { type: "result"; result: CheckResult }
  | { type: "done"; summary: CheckupSummary }
  | { type: "error"; message: string };

export interface CheckupTargets {
  apps: { id: string; name: string; icon: string | null; running: boolean }[];
  addresses: { id: string; name: string; host: string; url: string; enabled: boolean }[];
  disks: { id: string; title: string; model: string | null; name: string }[];
}

export interface CheckupState {
  /** Runs happening right now (any admin). */
  active: CheckupRunRow[];
  /** The most recent finished full checkup, with its results. */
  latest: CheckupRun | null;
  recent: CheckupRunRow[];
  targets: CheckupTargets;
}
