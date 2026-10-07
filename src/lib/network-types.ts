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
  /** Set when this address is an XMPP chat server; `host` is its domain and `backend` its client port. */
  xmpp?: XmppSettingsT;
  /** The whole host redirects here, keeping the path; `backend` is then unused. */
  redirect_to?: string;
  /** A voice server (Mumble): apps connect straight to `voice.port`; the web address shows a mumble:// link. */
  voice?: { port: number };
  /** Who handles HTTPS for this name. Absent: Caddy gets a certificate on its own. */
  https?: HttpsSettingsT;
}

/** "auto": Caddy gets and renews a certificate (the default, stored as no setting at all). */
export type HttpsModeT = "auto" | "own" | "http" | "none";
export interface HttpsSettingsT {
  mode: Exclude<HttpsModeT, "auto">;
  /** Own certificate copied from these files on the server whenever they change (certbot's live folder). */
  files?: { cert: string; key: string };
}

/** A certificate the person supplied. The key never leaves the server. */
export interface OwnCertInfo {
  host: string;
  names: string[];
  issuer: string | null;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint: string;
  /** Signed by itself: browsers and apps only accept it if told to trust it. */
  selfSigned: boolean;
  /** Plain sentences worth showing next to it (ends soon, self-signed). */
  warnings: string[];
}

/** Where a route's own certificate stands on the server. */
export interface OwnCertState {
  /** What Caddy serves from, null when the file is missing. */
  stored: OwnCertInfo | null;
  /** For certificates copied from files: when Gluon last copied, and what went wrong last time. */
  copiedAt: number | null;
  error: string | null;
}

export interface XmppSettingsT {
  /** Server-to-server port (federation); null when the server only talks to its own users. */
  s2s_port: number | null;
  /** The chat server's own HTTP port (BOSH, WebSocket, uploads). null: the web address shows a short page. */
  http_port: number | null;
  /** Copy Caddy's certificate for the domain into this container and reload it. */
  cert_sync: { container: string; dir: string } | null;
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
  /** Own certificates per route id (routes with https.mode "own"). */
  certs: Record<string, OwnCertState>;
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

/** Certificates pasted in the editor, sent with the save that uses them (by host). */
export type CertUploads = Record<string, { cert: string; key: string }>;

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
  /** SHA-256 fingerprint of the leaf certificate, when one was presented. */
  fingerprint?: string;
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
  /** Who handles HTTPS for the name ("auto" for path addresses and the base domain). */
  https: HttpsModeT;
  dns: DnsResult | null;
  /** Null when Caddy holds no certificate for it (plain HTTP, or no web side). */
  tls: TlsResult | null;
  http: HttpResult | null;
  backend: BackendResult | null;
  /** Chat server checks, for XMPP addresses. */
  xmpp: XmppStatus | null;
  /** Voice server checks, for Mumble addresses. */
  voice: VoiceStatus | null;
  state: ProbeState;
  /** Plain sentence: "Working", "Immich isn't answering on port 2283." */
  summary: string;
}

export interface SrvRecord {
  target: string;
  port: number;
  priority: number;
  weight: number;
}

export interface SrvResult {
  name: string;
  records: SrvRecord[];
  /** missing is fine: clients then connect to the domain itself on the standard port. */
  status: "ok" | "missing" | "mismatch" | "error";
  message: string;
}

export interface XmppPortResult {
  port: number;
  reachable: boolean;
  ms: number | null;
  error: string | null;
  /** The certificate the chat server presents after STARTTLS. */
  tls: TlsResult | null;
}

export interface XmppCertSync {
  container: string;
  /** When Gluon last compared or copied the certificate. */
  checkedAt: number | null;
  /** When it last copied a new one in. */
  copiedAt: number | null;
  ok: boolean;
  message: string;
}

export interface XmppStatus {
  domain: string;
  srv: { client: SrvResult; server: SrvResult | null };
  c2s: XmppPortResult;
  s2s: XmppPortResult | null;
  /** The chat server's HTTP side answers (only checked when it has one). */
  web: BackendResult | null;
  /** Anyone can create an account (in-band registration is open). null = couldn't tell. */
  openRegistration: boolean | null;
  certSync: XmppCertSync | null;
  /** Whether people outside can reach its ports through the router. */
  reach: PublicReach | null;
}

/** Mumble's answer to a UDP ping. */
export interface MumblePing {
  reachable: boolean;
  ms: number | null;
  version: string | null;
  users: number | null;
  maxUsers: number | null;
}

export interface VoiceStatus {
  host: string;
  port: number;
  /** Mumble answers on TCP from inside. */
  tcp: BackendResult;
  /** Mumble answers its UDP ping from inside. */
  udp: MumblePing;
  /** The certificate Mumble presents on its TCP port. */
  tls: TlsResult | null;
  reach: PublicReach | null;
}

// ---------------------------------------------------------------- reaching the router from inside

/**
 * same: the public address leads to this server (verified by certificate or protocol reply).
 * other: something answers on the public address, but not this server.
 * none: nothing answers there.
 */
export type ReachOutcome = "same" | "other" | "none";

export interface PortReach {
  port: number;
  proto: "tcp" | "udp";
  /** What uses the port: "Chat apps sign in". */
  label: string;
  /** People can't use the service at all without it (sign-in, voice), as opposed to extras like federation. */
  primary: boolean;
  lan: boolean;
  outside: ReachOutcome | null;
  verdict: "reachable" | "not-forwarded" | "elsewhere" | "unknown" | "down";
  message: string;
}

export interface PublicReach {
  checkedAt: number;
  publicIp: string | null;
  /** This server's address on the home network, to forward ports to. */
  lanIp: string | null;
  /** The router, from the default route. */
  gateway: string | null;
  /** Something answered on the public address, so the router lets devices inside use it. */
  hairpin: boolean | null;
  state: "ok" | "blocked" | "unknown";
  ports: PortReach[];
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

// ---------------------------------------------------------------- chat servers

/** A container on this server that looks like an XMPP chat server. */
export interface ChatServerCandidate {
  container: string;
  image: string;
  /** Compose project, which is usually the app's id. */
  project: string | null;
  running: boolean;
  /** Host ports for the client, federation and web sides (null when not published). */
  ports: { c2s: number | null; s2s: number | null; http: number | null };
  certDir: string;
  /** Gluon knows how to reload this server after copying a certificate. */
  canSync: boolean;
}

/** A container on this server that looks like a Mumble voice server. */
export interface VoiceServerCandidate {
  container: string;
  image: string;
  project: string | null;
  running: boolean;
  /** Host port mapped to Mumble's port (TCP), and whether UDP is published too. */
  port: number | null;
  udp: boolean;
  /** Every host port the container publishes. */
  ports: number[];
}

export interface ChatServersResponse {
  servers: ChatServerCandidate[];
  /** Certificate sync per chat address (route id), once Gluon has checked it. */
  sync: Record<string, XmppCertSync>;
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
