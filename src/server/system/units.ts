import "server-only";
import { AppError } from "../errors";
import type { ServiceAction } from "@/lib/system-types";

/**
 * Unit names, the curated "important" list and the safety policy for service actions.
 * Pure functions only, so they can be reused by routes, checks and remedies.
 */

/**
 * `^[A-Za-z0-9@._:-]+\.service$`, plus systemd's own `\xNN` escapes (e.g.
 * `systemd-fsck@dev-disk-by\x2duuid-….service`), which appear in real unit lists. Names are
 * passed as argv elements, never through a shell, but we still refuse anything else.
 */
const UNIT_RE = /^(?:[A-Za-z0-9@._:-]|\\x[0-9a-fA-F]{2})+\.service$/;

export function isValidUnit(unit: unknown): unit is string {
  return typeof unit === "string" && unit.length <= 256 && UNIT_RE.test(unit) && !unit.startsWith("-") && !unit.endsWith("@.service");
}

/** Validate (and lightly normalise: "smbd" → "smbd.service") a unit name from a person. */
export function parseUnit(raw: unknown): string {
  let unit = typeof raw === "string" ? raw.trim() : "";
  if (unit && !unit.includes(".")) unit += ".service";
  if (!isValidUnit(unit)) throw new AppError("invalid_unit", "That isn't a valid service name.", 400);
  return unit;
}

interface Known {
  name: string;
  important: boolean;
}

/** Friendly names. Anything matching is "important" unless marked otherwise. */
const KNOWN: [RegExp, Known][] = [
  [/^docker\.service$/, { name: "Docker", important: true }],
  [/^containerd\.service$/, { name: "Container runtime (containerd)", important: true }],
  [/^casaos\.service$/, { name: "CasaOS", important: true }],
  [/^casaos-gateway\.service$/, { name: "CasaOS gateway", important: true }],
  [/^casaos-app-management\.service$/, { name: "CasaOS app management", important: true }],
  [/^casaos-local-storage\.service$/, { name: "CasaOS storage", important: true }],
  [/^casaos-message-bus\.service$/, { name: "CasaOS message bus", important: true }],
  [/^casaos-user-service\.service$/, { name: "CasaOS users", important: true }],
  [/^casaos.*\.service$/, { name: "", important: true }],
  [/^(ssh|sshd)\.service$/, { name: "Remote login (SSH)", important: true }],
  [/^smbd\.service$/, { name: "Samba", important: true }],
  [/^nmbd\.service$/, { name: "Samba network names", important: true }],
  [/^winbind\.service$/, { name: "Samba accounts (winbind)", important: false }],
  [/^systemd-timesyncd\.service$/, { name: "Clock sync", important: true }],
  [/^chrony\.service$/, { name: "Clock sync (chrony)", important: true }],
  [/^ntpsec\.service$/, { name: "Clock sync (NTP)", important: true }],
  [/^cron\.service$/, { name: "Scheduled tasks (cron)", important: true }],
  [/^networking\.service$/, { name: "Networking", important: true }],
  [/^NetworkManager\.service$/, { name: "Networking (NetworkManager)", important: true }],
  [/^systemd-networkd\.service$/, { name: "Networking (systemd-networkd)", important: true }],
  [/^systemd-resolved\.service$/, { name: "Name lookups (DNS)", important: true }],
  [/^fail2ban\.service$/, { name: "Login blocker (fail2ban)", important: true }],
  [/^smartmontools\.service$/, { name: "Drive health monitor", important: false }],
  [/^udisks2\.service$/, { name: "Disk manager (udisks)", important: false }],
  [/^rclone\.service$/, { name: "rclone", important: false }],
  [/^nfs-server\.service$/, { name: "File sharing (NFS)", important: true }],
  [/^avahi-daemon\.service$/, { name: "Local network discovery", important: false }],
  [/^tailscaled\.service$/, { name: "Tailscale", important: true }],
  [/^wg-quick@.+\.service$/, { name: "", important: true }],
];

export function knownUnit(unit: string): Known | null {
  for (const [re, k] of KNOWN) if (re.test(unit)) return k;
  return null;
}

export function isImportant(unit: string): boolean {
  return knownUnit(unit)?.important ?? false;
}

/** The name people see: curated name, else systemd's description, else the unit without ".service". */
export function friendlyName(unit: string, description?: string | null): string {
  const k = knownUnit(unit);
  if (k?.name) return k.name;
  const d = description?.trim();
  if (d && d !== unit) return d;
  return unit.replace(/\.service$/, "");
}

/** Units that must never be stopped, restarted or disabled from a web page. */
const PROTECTED =
  /^(dbus|dbus-broker|systemd-journald|systemd-udevd|systemd-logind|polkit|user@\d+|user-runtime-dir@\d+|getty@tty\d+|serial-getty@.+|systemd-remount-fs|systemd-fsck.*|systemd-tmpfiles-setup.*|systemd-sysctl|systemd-modules-load|systemd-random-seed|systemd-journal-flush|systemd-user-sessions|kmod-static-nodes|ifupdown-pre|console-setup|keyboard-setup)\.service$/;

/** Units that change the machine's power state or drop to single-user mode when *started*. */
const POWER_STATE = /^(systemd-(halt|poweroff|reboot|kexec|soft-reboot|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|bsod)|emergency|rescue|halt|poweroff|reboot|kexec)\.service$/;

/** Stopping these takes every app (and Gluon itself) down. */
const TAKES_GLUON_DOWN = /^(docker|containerd)\.service$/;

/** Units Gluon runs itself (update runs, power timers). */
const OWN = /^(gluon-apt-|gluon-power-)/;

export interface Policy {
  blocked: ServiceAction[];
  needsConfirm: ServiceAction[];
  needsRecentAuth: ServiceAction[];
}

const ALL: ServiceAction[] = ["start", "stop", "restart", "reload", "enable", "disable"];

export function policyFor(unit: string): Policy {
  const blocked = new Set<ServiceAction>();
  const needsConfirm = new Set<ServiceAction>();
  const needsRecentAuth = new Set<ServiceAction>();
  if (PROTECTED.test(unit)) for (const a of ["stop", "restart", "disable"] as const) blocked.add(a);
  if (POWER_STATE.test(unit)) for (const a of ALL) blocked.add(a);
  if (OWN.test(unit)) for (const a of ALL) blocked.add(a);
  if (TAKES_GLUON_DOWN.test(unit)) for (const a of ["stop", "restart", "disable"] as const) needsConfirm.add(a);
  if (isImportant(unit)) for (const a of ["stop", "disable"] as const) needsRecentAuth.add(a);
  if (TAKES_GLUON_DOWN.test(unit)) needsRecentAuth.add("restart");
  // Enabling a unit changes what runs at every boot (e.g. an SSH server): a lasting change.
  if (!blocked.has("enable")) needsRecentAuth.add("enable");
  return {
    blocked: [...blocked],
    needsConfirm: [...needsConfirm],
    needsRecentAuth: [...needsRecentAuth],
  };
}

export function blockedReason(unit: string, action: ServiceAction): string {
  if (POWER_STATE.test(unit)) return "That service changes the machine's power state. Use Power in System instead.";
  if (OWN.test(unit)) return "Gluon manages that one itself.";
  return `The system needs ${unit.replace(/\.service$/, "")} to keep running, so Gluon won't ${action} it. Use a terminal if you're sure.`;
}

export const takesGluonDown = (unit: string) => TAKES_GLUON_DOWN.test(unit);

// ---------------------------------------------------------------- systemctl show parsing

/** `systemctl show a b c -p X,Y` → one record per unit (blank-line separated). */
export function parseShow(stdout: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const rec: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      rec[line.slice(0, i)] = line.slice(i + 1);
    }
    if (Object.keys(rec).length) out.push(rec);
  }
  return out;
}

const U64_MAX = "18446744073709551615";

/** systemd numbers: "[not set]", "infinity" and UINT64_MAX mean "unknown". */
export function showNumber(v: string | undefined): number | null {
  if (v === undefined || v === "" || v === "[not set]" || v === "infinity" || v === U64_MAX) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `--timestamp=unix` gives "@1790375574"; older systemd gives a date string, "n/a" or "". */
export function showTimestamp(v: string | undefined): number | null {
  if (!v || v === "n/a" || v === "0") return null;
  const m = v.match(/^@(\d+)$/);
  if (m) return Number(m[1]) * 1000 || null;
  // "Fri 2026-09-25 17:32:54 CDT" — Date can't parse the zone abbreviation reliably; drop it and
  // accept the result as host-local time only when it looks sane.
  const d = Date.parse(v.replace(/^\w{3} /, "").replace(/ [A-Z]{2,5}$/, ""));
  return Number.isFinite(d) ? d : null;
}

/** Split systemd list properties ("a.target b.target"). */
export const showList = (v: string | undefined) => (v ? v.split(/\s+/).filter(Boolean) : []);

// ---------------------------------------------------------------- plain-language descriptions

/** What common services do, for people who don't know systemd. First match wins. */
const ABOUT: [RegExp, string][] = [
  [/^docker\.service$/, "Runs every app on this server. Stopping it stops them all, including Gluon."],
  [/^containerd\.service$/, "The engine under Docker that actually runs the app containers."],
  [/^casaos\.service$/, "The CasaOS dashboard and app store."],
  [/^casaos-/, "Part of CasaOS. Apps keep running without it, but the CasaOS dashboard needs it."],
  [/^(ssh|sshd)\.service$/, "Lets people sign in to this machine from another computer over SSH."],
  [/^sshd-keygen/, "Makes the server's SSH identity keys the first time it starts."],
  [/^smbd\.service$/, "Shares folders with Windows, Mac and phone file browsers on your network."],
  [/^nmbd\.service$/, "Makes this server show up by name in older Windows network browsers."],
  [/^samba-ad-dc\.service$/, "Samba's Windows domain controller mode. Most homes don't use it."],
  [/^winbind\.service$/, "Lets Samba look up Windows accounts."],
  [/^nfs-server\.service$/, "Shares folders with Linux machines over NFS."],
  [/^(systemd-timesyncd|chrony|ntpsec)\.service$/, "Keeps the clock right by asking internet time servers."],
  [/^cron\.service$/, "Runs scheduled tasks at set times."],
  [/^(networking|ifup@.+)\.service$/, "Brings the network connection up at boot."],
  [/^NetworkManager\.service$/, "Manages network connections."],
  [/^systemd-networkd\.service$/, "Manages network connections."],
  [/^connman\.service$/, "A network connection manager. Usually only one is needed."],
  [/^firewalld\.service$/, "The firewall: decides which connections may reach this server."],
  [/^(ufw|nftables|netfilter-persistent)\.service$/, "The firewall rules that decide which connections may reach this server."],
  [/^systemd-resolved\.service$/, "Turns website names into addresses for this machine."],
  [/^fail2ban\.service$/, "Blocks addresses that keep failing to sign in."],
  [/^crowdsec\.service$/, "Blocks addresses that behave like attackers."],
  [/^smartmontools\.service$/, "Watches the drives' health reports and warns before one fails."],
  [/^udisks2\.service$/, "Mounts USB drives and other removable disks."],
  [/^devmon@/, "Mounts USB drives automatically when they're plugged in."],
  [/^rclone\.service$/, "Syncs or mounts cloud storage with rclone."],
  [/^avahi-daemon\.service$/, "Announces this server on the local network so others find it as name.local."],
  [/^tailscaled\.service$/, "Connects this server to your Tailscale network for remote access."],
  [/^wg-quick@/, "A WireGuard VPN connection."],
  [/^apt-daily\.service$/, "Downloads the list of available updates once a day."],
  [/^apt-daily-upgrade\.service$/, "Installs security updates automatically, if that's turned on."],
  [/^unattended-upgrades\.service$/, "Installs security updates automatically."],
  [/^dpkg-db-backup\.service$/, "Backs up the list of installed software once a day."],
  [/^logrotate\.service$/, "Trims and compresses old log files so they don't fill the disk."],
  [/^man-db\.service$/, "Keeps the manual pages' index up to date."],
  [/^fstrim\.service$/, "Tells SSDs which space is free, once a week, to keep them fast."],
  [/^e2scrub/, "Checks ext4 file systems for errors in the background."],
  [/^auditd\.service$/, "Records security-relevant events for auditing."],
  [/^apparmor\.service$/, "Loads security profiles that limit what programs may do."],
  [/^polkit\.service$/, "Decides which users may do administrator actions."],
  [/^dbus(-broker)?\.service$/, "Lets system programs talk to each other. The system needs it."],
  [/^systemd-journald\.service$/, "Collects the logs you see here. The system needs it."],
  [/^systemd-logind\.service$/, "Tracks who is signed in and handles power buttons. The system needs it."],
  [/^systemd-udevd\.service$/, "Sets up hardware as it appears. The system needs it."],
  [/^systemd-oomd\.service$/, "Stops runaway programs before memory runs out."],
  [/^(syslog|rsyslog)\.service$/, "Writes logs to files in /var/log."],
  [/^getty@tty\d+\.service$/, "The sign-in prompt on the screen plugged into the server."],
  [/^display-manager\.service$/, "The graphical sign-in screen."],
  [/^user@\d+\.service$/, "Background programs for a signed-in person."],
  [/^user-runtime-dir@/, "Temporary files for a signed-in person."],
  [/^rc-local\.service$/, "Runs /etc/rc.local at boot, if it exists."],
  [/^console-setup\.service$|^keyboard-setup\.service$|^kbd\.service$/, "Sets the keyboard layout and font on the server's screen."],
  [/^grub-common\.service$/, "Records that the last boot worked, for the boot menu."],
  [/^wtmpdb-update-boot\.service$/, "Records each boot in the sign-in history."],
  [/^systemd-fsck/, "Checks a disk for errors before it's mounted at boot."],
  [/^systemd-tmpfiles/, "Creates and cleans temporary folders."],
  [/^plymouth/, "The boot splash screen."],
];

export function aboutUnit(unit: string): string | null {
  for (const [re, text] of ABOUT) if (re.test(unit)) return text;
  return null;
}
