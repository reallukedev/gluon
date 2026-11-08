export interface SystemOverview {
  hostname: string;
  prettyHostname: string | null;
  os: { prettyName: string; name: string | null; version: string | null; versionFull: string | null; codename: string | null; id: string | null };
  kernel: { release: string; version: string | null };
  architecture: string;
  cpu: { model: string | null; cores: number | null; threads: number; sockets: number | null; mhz: number | null };
  memory: { total: number; available: number; used: number; swapTotal: number; swapUsed: number };
  hardware: {
    vendor: string | null;
    product: string | null;
    boardVendor: string | null;
    board: string | null;
    biosVersion: string | null;
    biosDate: string | null;
    chassis: string | null;
  };
  bootedAt: number;
  uptimeSeconds: number;
  time: TimeStatus;
  /** "none" on bare metal; otherwise kvm, vmware, docker… */
  virtualization: string | null;
  temperatures: { chip: string; label: string; celsius: number; high: number | null; crit: number | null }[];
  cpuTemperature: number | null;
  casaos: string | null;
  umbrel: string | null;
  docker: string | null;
  systemd: string | null;
  reboot: RebootStatus;
}

export interface TimeStatus {
  timezone: string | null;
  ntp: boolean | null;
  synced: boolean | null;
  /** Whether NTP can be toggled (a time-sync service is installed). */
  canNtp: boolean | null;
  localRtc: boolean | null;
  now: number;
  server: string | null;
}

export interface PendingPackage {
  name: string;
  /** Installed version (null for a package the upgrade would newly install). */
  current: string | null;
  candidate: string;
  arch: string | null;
  suite: string | null;
  origins: string[];
  security: boolean;
  needsReboot: boolean;
  rebootReason: "kernel" | "systemd" | "libc" | "firmware" | "microcode" | "dbus" | null;
  /** Epoch ms when Gluon first saw this version waiting. */
  firstSeen: number;
  /** A new package the upgrade pulls in (e.g. a new kernel), not something already installed. */
  isNew: boolean;
  /** "Install all" leaves it out (it would remove something); choosing it on its own still works. */
  heldBack: boolean;
}

export interface RebootStatus {
  required: boolean;
  reasons: string[];
  runningKernel: string;
  newestKernel: string | null;
  packages: string[];
  since: number | null;
}

export interface RestartNeeded {
  reboot: RebootStatus;
  services: { unit: string; name: string; important: boolean; pids: number[]; libraries: string[] }[];
  other: { pid: number; command: string; libraries: string[] }[];
  /** "needrestart" when that tool answered, otherwise Gluon's own scan. */
  source: "needrestart" | "scan";
  checkedAt: number;
}

export interface AptLockHolder {
  pid: number;
  command: string;
  lock: string;
}

export interface UpdatesStatus {
  packages: PendingPackage[];
  counts: { total: number; security: number; needsReboot: number; newPackages: number; removals: number; heldBack: number };
  /** Packages the upgrade would remove (rare; shown as a warning). */
  removals: string[];
  lastRefresh: { at: number | null; ok: boolean | null; error: string | null; lastSuccessAt: number | null };
  /** How old the package lists on disk are (mtime of newest list file), epoch ms. */
  listsUpdatedAt: number | null;
  /** Another apt/dpkg process is running (unattended-upgrades, someone over SSH…). */
  busy: AptLockHolder[];
  activeRun: UpdateRunSummary | null;
  /** dpkg was interrupted and needs "Repair" before anything else can install. */
  dpkgInterrupted: boolean;
  reboot: RebootStatus;
  oldestPendingAt: number | null;
  oldestSecurityAt: number | null;
  checkedAt: number;
}

export type UpdateRunKind = "refresh" | "upgrade" | "repair";
export type UpdateRunOutcome = "running" | "ok" | "failed" | "interrupted";

export interface UpdateRunSummary {
  id: string;
  kind: UpdateRunKind;
  startedAt: number;
  finishedAt: number | null;
  username: string | null;
  /** Packages chosen; null = everything. */
  packages: string[] | null;
  outcome: UpdateRunOutcome;
  exitCode: number | null;
  summary: string | null;
}

export interface UpdateRun extends UpdateRunSummary {
  log: string;
}

/** SSE events on /api/system/updates/runs/[id]/stream */
export type UpdateRunEvent =
  /** `from` is the line number of lines[0]; later "line" events continue from there (dedupe by n). */
  { event: "snapshot"; data: { run: UpdateRunSummary; lines: string[]; from: number } } | { event: "line"; data: { n: number; text: string } } | { event: "done"; data: { run: UpdateRunSummary } };

export type ServiceAction = "start" | "stop" | "restart" | "reload" | "enable" | "disable";

export interface ServiceInfo {
  unit: string;
  name: string;
  description: string;
  about: string | null;
  load: string; // loaded | not-found | masked | error
  active: string; // active | inactive | failed | activating | deactivating | reloading
  sub: string; // running | exited | dead | failed | auto-restart …
  /** enabled | disabled | static | masked | indirect | generated | alias | transient | null */
  enabled: string | null;
  mainPid: number | null;
  memory: number | null;
  cpuNs: number | null;
  restarts: number | null;
  activeSince: number | null;
  inactiveSince: number | null;
  result: string | null; // success | exit-code | signal | timeout | oom-kill | start-limit-hit …
  exitStatus: number | null;
  canReload: boolean;
  canStart: boolean;
  canStop: boolean;
  important: boolean;
  /** Gluon refuses some actions (e.g. stopping D-Bus). Actions not allowed for this unit. */
  blocked: ServiceAction[];
  /** Actions that need the extra confirmation flag (stopping Docker takes every app down). */
  needsConfirm: ServiceAction[];
  /** Actions that need a fresh sign-in (stop/disable of important services). */
  needsRecentAuth: ServiceAction[];
  path: string | null;
}

export interface ServiceDetail extends ServiceInfo {
  execStart: string | null;
  user: string | null;
  wantedBy: string[];
  after: string[];
  triggeredBy: string[];
  documentation: string[];
  tasks: number | null;
  statusText: string;
}

export interface JournalEntry {
  time: number;
  /** 0 emerg … 7 debug */
  priority: number;
  message: string;
  identifier: string | null;
  pid: number | null;
  cursor: string;
}

export interface PowerStatus {
  scheduled: { mode: "reboot" | "poweroff" | "halt" | string; at: number } | null;
  /** An update run is in progress (restarting now would interrupt it). */
  updateRunning: boolean;
  reboot: RebootStatus;
  impact: PowerImpact | null;
}

export interface MemoryBreakdown {
  total: number;
  /** total − available: what programs hold and can't give back. */
  used: number;
  available: number;
  /** Docker apps, largest first. `bytes` excludes reclaimable file cache (like `docker stats`). */
  apps: { id: string; name: string; bytes: number; containers: number }[];
  /** Used memory not attributed to an app: the system, services, Gluon's neighbours. */
  other: number;
  swap: { total: number; used: number };
  at: number;
}

export type LoginZone = "home" | "away" | "local";

export type SessionKind =
  /** An interactive terminal. */
  | "shell"
  /** `ssh host command` with no terminal. */
  | "command"
  /** SFTP / file copies. */
  | "files"
  /** Connected with no terminal and nothing running: port forwarding or a shared connection. */
  | "tunnel"
  /** Keyboard and screen plugged into the server. */
  | "console"
  | "desktop";

export type LoginMethod = "key" | "password" | "keyboard" | "other";

export interface LiveSession {
  id: string;
  user: string;
  kind: SessionKind;
  from: { ip: string | null; port: number | null; host: string | null; zone: LoginZone };
  tty: string | null;
  service: string | null;
  startedAt: number;
  /** Seconds since the last keystroke (terminals only). */
  idleSeconds: number | null;
  /** The program in the foreground. Only its name: arguments can hold secrets. */
  running: { program: string; label: string | null } | null;
  processes: number;
  method: LoginMethod | null;
  keyLabel: string | null;
  canEnd: boolean;
  endBlocked: string | null;
}

export interface SshPosture {
  /** sshd is installed (sshd -T answered). */
  installed: boolean;
  running: boolean | null;
  unit: string | null;
  ports: number[];
  /** Passwords are accepted (PasswordAuthentication or keyboard-interactive). */
  password: boolean | null;
  emptyPasswords: boolean | null;
  keys: boolean | null;
  root: "yes" | "keys-only" | "commands-only" | "no" | null;
  maxAuthTries: number | null;
  allowUsers: string[];
  blocker: { name: string; running: boolean } | null;
  /** Evidence from the last 7 days: sign-ins or attempts from outside the home network. */
  seenFromOutside: boolean;
  error: string | null;
}

export interface LiveLogins {
  sessions: LiveSession[];
  posture: SshPosture;
  checkedAt: number;
}

/** Overlapping sessions of one person merged into one stretch (for the swimlane). */
export interface SignInSpan {
  start: number;
  /** Epoch ms; for open spans, when the data was read. */
  end: number;
  open: boolean;
  count: number;
  sources: (string | null)[];
  away: boolean;
  console: boolean;
}

export interface SignInLane {
  user: string;
  sessions: number;
  awaySessions: number;
  open: number;
  lastAt: number | null;
  spans: SignInSpan[];
}

export interface SignInSource {
  user: string;
  ip: string | null;
  host: string | null;
  zone: LoginZone;
  method: LoginMethod | null;
  keyLabel: string | null;
  count: number;
  firstAt: number;
  lastAt: number;
  open: number;
}

export interface FailedAttempts {
  from: number;
  binMs: number;
  bins: number[];
  awayBins: number[];
  total: number;
  away: number;
  lastHour: number;
  lastHourAway: number;
  sources: { ip: string; host: string | null; zone: LoginZone; count: number; lastAt: number; users: string[] }[];
  /** Account names tried, most tried first; `exists` = a real account on this machine. */
  names: { name: string; count: number; exists: boolean }[];
}

export interface SignInHistory {
  from: number;
  to: number;
  lanes: SignInLane[];
  sources: SignInSource[];
  failures: FailedAttempts;
  boots: number[];
  origin: { journal: boolean; wtmp: boolean };
  /** Oldest sign-in record available (the journal may have been trimmed). */
  oldestRecord: number | null;
  checkedAt: number;
}

export interface PowerApp {
  id: string;
  name: string;
  icon: string | null;
  /** Every running container restarts on its own after a restart (Docker restart policy). */
  comesBack: "yes" | "no" | "partly";
  staysOff: string[];
  startedBy: "docker" | "umbrel";
}

export interface PowerImpact {
  apps: PowerApp[];
  sessions: { user: string; count: number; zone: LoginZone }[];
}
