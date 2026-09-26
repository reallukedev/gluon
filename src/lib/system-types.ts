/**
 * Types shared between the System section's API (src/app/api/system/**) and the client.
 * No server imports here.
 */

// ---------------------------------------------------------------- overview

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
  /** Epoch ms. */
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
  /** Automatic time (NTP) turned on. */
  ntp: boolean | null;
  /** The clock has synchronised with a time server. */
  synced: boolean | null;
  /** Whether NTP can be toggled (a time-sync service is installed). */
  canNtp: boolean | null;
  localRtc: boolean | null;
  /** Current server time, epoch ms. */
  now: number;
  /** Time server in use, when known. */
  server: string | null;
}

// ---------------------------------------------------------------- updates

export interface PendingPackage {
  name: string;
  /** Installed version (null for a package the upgrade would newly install). */
  current: string | null;
  candidate: string;
  arch: string | null;
  /** First suite apt listed (trixie-security, trixie-updates, trixie…). */
  suite: string | null;
  /** Origins from apt's simulation, e.g. "Debian-Security:13/stable-security". */
  origins: string[];
  security: boolean;
  /** Installing it means restarting the machine to take effect. */
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
  /** Plain-language reasons: "A newer kernel (6.12.108) is installed", … */
  reasons: string[];
  runningKernel: string;
  newestKernel: string | null;
  /** Packages listed in /run/reboot-required.pkgs. */
  packages: string[];
  /** Epoch ms of /run/reboot-required, when present. */
  since: number | null;
}

export interface RestartNeeded {
  reboot: RebootStatus;
  /** Services still running old copies of updated libraries. */
  services: { unit: string; name: string; important: boolean; pids: number[]; libraries: string[] }[];
  /** Processes outside services (login sessions, containers' host helpers). */
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
  /** apt-get update. Epoch ms. */
  lastRefresh: { at: number | null; ok: boolean | null; error: string | null; lastSuccessAt: number | null };
  /** How old the package lists on disk are (mtime of newest list file), epoch ms. */
  listsUpdatedAt: number | null;
  /** Another apt/dpkg process is running (unattended-upgrades, someone over SSH…). */
  busy: AptLockHolder[];
  /** A Gluon update run in progress. */
  activeRun: UpdateRunSummary | null;
  /** dpkg was interrupted and needs "Repair" before anything else can install. */
  dpkgInterrupted: boolean;
  reboot: RebootStatus;
  /** Oldest firstSeen among waiting packages, epoch ms. */
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
  /** "Installed 12 updates", "apt couldn't reach deb.debian.org", … */
  summary: string | null;
}

export interface UpdateRun extends UpdateRunSummary {
  log: string;
}

/** SSE events on /api/system/updates/runs/[id]/stream */
export type UpdateRunEvent =
  /** `from` is the line number of lines[0]; later "line" events continue from there (dedupe by n). */
  { event: "snapshot"; data: { run: UpdateRunSummary; lines: string[]; from: number } } | { event: "line"; data: { n: number; text: string } } | { event: "done"; data: { run: UpdateRunSummary } };

// ---------------------------------------------------------------- services

export type ServiceAction = "start" | "stop" | "restart" | "reload" | "enable" | "disable";

export interface ServiceInfo {
  unit: string;
  /** Friendly name for important services ("File sharing (Samba)"), else the description. */
  name: string;
  description: string;
  /** What it does, in plain words, for common services (null when Gluon doesn't know it). */
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
  /** Epoch ms the service last became active. */
  activeSince: number | null;
  /** Epoch ms the service last stopped (useful for failed units). */
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
  /** A human sentence about the current state: "Running since 3 days ago", "Stopped: exited with code 1". */
  statusText: string;
}

export interface JournalEntry {
  /** Epoch ms. */
  time: number;
  /** 0 emerg … 7 debug */
  priority: number;
  message: string;
  identifier: string | null;
  pid: number | null;
  cursor: string;
}

// ---------------------------------------------------------------- power

export interface PowerStatus {
  scheduled: { mode: "reboot" | "poweroff" | "halt" | string; at: number } | null;
  /** An update run is in progress (restarting now would interrupt it). */
  updateRunning: boolean;
  reboot: RebootStatus;
  /** What a restart does to apps and signed-in people (null when it couldn't be worked out). */
  impact: PowerImpact | null;
}

// ---------------------------------------------------------------- memory by app

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

// ---------------------------------------------------------------- sign-ins (SSH and console)

/** Where a sign-in came from: the home network, outside it, or the machine's own keyboard. */
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
  /** logind session id. */
  id: string;
  user: string;
  kind: SessionKind;
  from: { ip: string | null; port: number | null; host: string | null; zone: LoginZone };
  /** pts/0, tty1, or null when there's no terminal. */
  tty: string | null;
  /** sshd, login, … */
  service: string | null;
  startedAt: number;
  /** Seconds since the last keystroke (terminals only). */
  idleSeconds: number | null;
  /** The program in the foreground. Only its name: arguments can hold secrets. */
  running: { program: string; label: string | null } | null;
  processes: number;
  method: LoginMethod | null;
  /** The key's comment in authorized_keys, when it signed in with a key. */
  keyLabel: string | null;
  canEnd: boolean;
  /** Why it can't be ended from here. */
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
  /** How root may sign in. */
  root: "yes" | "keys-only" | "commands-only" | "no" | null;
  maxAuthTries: number | null;
  allowUsers: string[];
  /** Something blocks addresses after repeated failures. */
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
  /** Up to 4 distinct source addresses (null for the console). */
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
  /** Start of the first bin, epoch ms. */
  from: number;
  binMs: number;
  /** All failed attempts per bin, oldest first. */
  bins: number[];
  /** The part of each bin that came from outside the home network. */
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
  /** When the machine started, inside the window. */
  boots: number[];
  /** Where the history comes from. */
  origin: { journal: boolean; wtmp: boolean };
  /** Oldest sign-in record available (the journal may have been trimmed). */
  oldestRecord: number | null;
  checkedAt: number;
}

// ---------------------------------------------------------------- power: what happens to apps

export interface PowerApp {
  id: string;
  name: string;
  icon: string | null;
  /** Every running container restarts on its own after a restart (Docker restart policy). */
  comesBack: "yes" | "no" | "partly";
  /** Containers that stay off after a restart. */
  staysOff: string[];
  /** Who starts it again: Docker's restart policy, or Umbrel for the apps it manages. */
  startedBy: "docker" | "umbrel";
}

export interface PowerImpact {
  apps: PowerApp[];
  /** Live SSH/console sessions that would be cut. */
  sessions: { user: string; count: number; zone: LoginZone }[];
}
