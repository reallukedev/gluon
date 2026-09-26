/** Types shared between the Network API and the client. No server imports. */

export type Severity = "fault" | "attention" | "info";

// ---------------------------------------------------------------- routes (public addresses)

export interface BackendT {
  host: string;
  port: number;
  tls: boolean;
}

interface RouteBase {
  id: string;
  name: string;
  enabled: boolean;
  app?: string;
  note?: string;
}
export interface SubdomainRouteT extends RouteBase {
  type: "subdomain";
  host: string;
  backend: BackendT;
  only_paths?: string[];
  /** Paths on this subdomain served by a different backend. Kept as-is by the editor. */
  extra_paths?: { paths: string[]; backend: { host: string; port: number; tls: boolean }; note?: string }[];
}
export interface PathRouteT extends RouteBase {
  type: "path";
  path: string;
  backend: BackendT;
  strip_prefix: boolean;
}
export interface RedirectRouteT extends RouteBase {
  type: "redirect";
  path: string;
  target: string;
}
export type RouteT = SubdomainRouteT | PathRouteT | RedirectRouteT;

export interface RoutesConfigT {
  base_domain: string;
  fallback: { name: string; app?: string | null; backend: BackendT };
  routes: RouteT[];
  updated?: string;
}

/** The app a public address leads to, as far as Gluon can tell. */
export interface RouteAppRef {
  appId: string;
  name: string;
  /** Declared by the admin in app settings. */
  hasLogin: "yes" | "no" | "unknown";
}

export interface RoutesResponse {
  config: RoutesConfigT;
  rev: string;
  /** The Caddyfile on disk isn't what Gluon would generate from routes.json (edited by hand or by another tool). */
  drift: boolean;
  /** When drifted: who last wrote the file (from its header comment) and how many settings lines differ (comments ignored). */
  driftInfo?: DriftInfo | null;
  caddyRunning: boolean;
  /** Public URL per route id (and "__fallback__"). */
  urls: Record<string, string>;
  /** App per route id (and "__fallback__"), when known. */
  apps: Record<string, RouteAppRef>;
  /** The wildcard *.base covers it, so no DNS change is needed. Per subdomain route id. */
  coveredByWildcard: Record<string, boolean>;
}

export interface DriftInfo {
  /** "the Domains app", when the file's header says who generated it. */
  writer: string | null;
  /** Lines that change what Caddy does (comments and blank lines ignored). 0 = only comments differ. */
  settingLines: number;
  /** A few of those lines as they are on disk, for a one-line explanation. */
  sample: string[];
}

export interface RouteWarning {
  routeId: string;
  /** Plain sentence, e.g. "Octo has no login of its own, so anyone with the address can use it." */
  message: string;
  /** Published (or re-enabled) by this save, as opposed to already public before. */
  isNew: boolean;
}

export interface RoutesSaveResponse extends Omit<RoutesResponse, "caddyRunning"> {
  warnings: RouteWarning[];
  /** "Added photos.example.com; removed …" */
  summary: string;
}

export interface RoutesHistoryEntry {
  id: string;
  time: string;
  reason: string;
  hasRoutes: boolean;
}

export interface CaddyfileResponse {
  /** The Caddyfile on disk ("" if missing). */
  text: string;
  /** What Gluon would generate from routes.json right now. */
  generated: string;
  drift: boolean;
  driftInfo: DriftInfo | null;
}

// ---------------------------------------------------------------- status

export type ProbeState = "ok" | "attention" | "fault" | "pending" | "disabled" | "unknown";

export interface DnsResult {
  name: string;
  a: string[];
  aaaa: string[];
  /** Every A/AAAA answer is a Cloudflare edge address (orange cloud). null = no answers. */
  proxied: boolean | null;
  /** Answers point at this network's public address. null = can't tell (no public IP known, or proxied). */
  matchesPublicIp: boolean | null;
  status: "ok" | "missing" | "mismatch" | "error";
  message: string;
  resolver: string;
}

export interface TlsResult {
  servername: string;
  status: "ok" | "expiring" | "expired" | "pending" | "invalid" | "error";
  issuer: string | null;
  subject: string | null;
  names: string[];
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  /** Chain verified against the system CAs. */
  trusted: boolean | null;
  /** Caddy's last certificate error for this name, from its log. */
  issueError: string | null;
  message: string;
}

export interface HttpResult {
  url: string;
  status: number | null;
  location: string | null;
  ms: number | null;
  error: string | null;
}

export interface BackendResult {
  host: string;
  port: number;
  reachable: boolean;
  ms: number | null;
  error: string | null;
}

export interface RouteStatus {
  id: string; // route id or "__fallback__"
  name: string;
  type: RouteT["type"] | "fallback";
  url: string;
  host: string;
  enabled: boolean;
  app: RouteAppRef | null;
  dns: DnsResult | null;
  tls: TlsResult | null;
  http: HttpResult | null;
  backend: BackendResult | null;
  state: ProbeState;
  /** Plain sentence: "Working", "Immich isn't answering on port 2283." */
  summary: string;
}

export interface NetworkStatus {
  checkedAt: number;
  baseDomain: string;
  publicIp: { v4: string | null; v6: string[]; source: "ddns" | "lookup" | "none" };
  wildcard: DnsResult | null;
  base: DnsResult | null;
  routes: RouteStatus[];
  caddyRunning: boolean;
  counts: { ok: number; attention: number; fault: number; pending: number; disabled: number };
}

// ---------------------------------------------------------------- DDNS

export interface DdnsLogLine {
  at: number | null;
  level: "error" | "warning" | "info" | "update";
  message: string;
}

export interface DdnsStatus {
  container: {
    exists: boolean;
    name: string;
    state: string | null;
    running: boolean;
    startedAt: string | null;
    image: string | null;
    version: string | null;
    project: string | null;
  };
  config: {
    domains: string[];
    ip4Domains: string[];
    ip6Domains: string[];
    proxied: string | null;
    proxiedDomains: string[];
    unproxiedDomains: string[];
    ip4Provider: string | null;
    ip6Provider: string | null;
    updateSchedule: string | null;
  };
  ipv4: { address: string; at: number | null } | null;
  ipv6: { addresses: string[]; at: number | null } | null;
  lastCheckAt: number | null;
  lastChange: { at: number | null; message: string } | null;
  /** Errors since the last successful check. Empty = healthy. */
  errors: DdnsLogLine[];
  recent: DdnsLogLine[];
  /** One sentence for the UI. */
  summary: string;
  state: ProbeState;
}

// ---------------------------------------------------------------- exposure audit

export type LoginVerdict = "login" | "no-login" | "unknown";

export interface LoginInfo {
  /** What the admin set on the app. */
  declared: "yes" | "no" | "unknown" | null;
  /** Gluon's own look at the page: "login" = looks like it has a login, "none" = no login detected. */
  probe: "login" | "none" | "unknown" | null;
  evidence: string | null;
  checkedAt: number | null;
  verdict: LoginVerdict;
}

export interface InternetExposure {
  routeId: string; // or "__fallback__"
  name: string;
  url: string;
  type: RouteT["type"] | "fallback";
  onlyPaths: string[] | null;
  backend: { host: string; port: number };
  app: RouteAppRef | null;
  /** Owner of the listening socket on the backend port. */
  listener: { process: string | null; container: string | null } | null;
  /** Something is listening on the backend port (null for non-local backends). */
  backendListening: boolean | null;
  viaCloudflare: boolean;
  adminUi: boolean;
  login: LoginInfo;
}

export type ListenScope = "all" | "lan" | "containers" | "local" | "link";

export interface LanExposure {
  key: string;
  proto: "tcp" | "udp";
  port: number;
  addresses: string[];
  scope: ListenScope;
  /** "Samba file sharing", "SSH", "Jellyfin" … */
  label: string;
  process: string | null;
  pids: number[];
  container: { id: string; name: string } | null;
  app: { id: string; name: string } | null;
  /** systemd unit, for host services. */
  unit: string | null;
  /** Published Docker port: host port → container port. */
  published: { containerPort: number; bindIp: string } | null;
  /** Public addresses (route ids) that lead here. */
  publicRoutes: string[];
  login: LoginInfo | null;
  /** Housekeeping sockets (DHCP, NetBIOS, mDNS) people rarely care about. */
  system: boolean;
}

export interface ExposureFlag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  subject: string | null;
  href: string | null;
}

export interface ExposureReport {
  checkedAt: number;
  summary: string[];
  counts: { internet: number; internetNoLogin: number; lan: number; lanAllInterfaces: number; lanNoLogin: number; flags: number };
  internet: InternetExposure[];
  lan: LanExposure[];
  flags: ExposureFlag[];
}
