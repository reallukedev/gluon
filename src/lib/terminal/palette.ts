import { parseTarget, type TargetId } from "./types";

/**
 * Whether something typed into the command palette reads like a command to run. "$ df -h" and
 * "> uptime" always do; pipes, flags and redirects do; a known program name does, weakly ("free"
 * is also a word), so the palette offers it below everything else.
 */
const KNOWN = new Set(
  (
    "apt apt-get cat cd chmod chown cp crontab curl date df dig dmesg docker du echo env find free git grep head hostname hostnamectl htop " +
    "ip iostat journalctl kill less ls lsblk lsof mkdir mount mv nano ncdu netstat node npm nslookup ping pip pkill prosodyctl ps python3 rm " +
    "sensors smartctl sqlite3 ss stat sudo systemctl tail tailscale tar timedatectl top touch traceroute umount uname uptime vim vmstat wget " +
    "which whoami zip unzip"
  ).split(" "),
);

export interface PaletteCommand {
  command: string;
  /** Typed as a command on purpose ($ prefix, pipes, flags): offer it first. */
  strong: boolean;
}

export function paletteCommand(query: string): PaletteCommand | null {
  const q = query.trim();
  if (!q || q.length > 500) return null;
  const forced = q.match(/^[$>]\s*(.+)$/);
  if (forced) return { command: forced[1]!.trim(), strong: true };
  const first = q.split(/\s+/)[0]!;
  if (!/^[\w./~-]+$/.test(first)) return null;
  const syntax = /\s(-{1,2}[A-Za-z]|\||&&|;|>|<)|\$\(|^\.{0,2}\//.test(q);
  if (syntax && (KNOWN.has(first) || first.includes("/"))) return { command: q, strong: true };
  if (KNOWN.has(first)) return { command: q, strong: false };
  return null;
}

// ------------------------------------------------------------------ hand-offs between pages (browser only)

const AUTORUN = "gluon.terminal.autorun";

/** Sent by the palette when the terminal page is already open. */
export const TERMINAL_RUN_EVENT = "gluon:terminal-run";

/**
 * The palette asks the terminal to run a command right away. A link with ?run= only fills the
 * prompt (a link from anywhere must never run anything); this note in sessionStorage, which only
 * Gluon's own pages can write, is what lets the palette's choice run on arrival.
 */
export function requestAutorun(target: TargetId, command: string) {
  try {
    sessionStorage.setItem(AUTORUN, JSON.stringify({ target, command, at: Date.now() }));
  } catch {
    /* private mode: the command is still filled in */
  }
}

export function takeAutorun(target: TargetId, command: string): boolean {
  try {
    const raw = sessionStorage.getItem(AUTORUN);
    sessionStorage.removeItem(AUTORUN);
    if (!raw) return false;
    const v = JSON.parse(raw) as { target?: string; command?: string; at?: number };
    return v.target === target && v.command === command && typeof v.at === "number" && Date.now() - v.at < 15_000;
  } catch {
    return false;
  }
}

const lastKey = (userId: string) => `gluon.terminal.target.${userId}`;

export function lastTarget(userId: string): TargetId | null {
  try {
    return parseTarget(localStorage.getItem(lastKey(userId)));
  } catch {
    return null;
  }
}

export function saveLastTarget(userId: string, t: TargetId) {
  try {
    localStorage.setItem(lastKey(userId), t);
  } catch {
    /* storage full or blocked */
  }
}

export function terminalHref(target: TargetId, command?: string, mode?: "terminal") {
  const p = new URLSearchParams({ target });
  if (command) p.set("run", command);
  if (mode) p.set("mode", mode);
  return `/terminal?${p.toString()}`;
}
