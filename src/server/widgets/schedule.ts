import "server-only";
import { host } from "../host/exec";
import { hostExists } from "../host/paths";
import { getSetting } from "../settings";
import { cached } from "../integrations/cache";
import type { ScheduleData, ScheduleItem } from "@/lib/home-widgets-types";

/**
 * "Coming up": what the server will do on its own next. The host's systemd timers (with plain names for the common
 * ones), Gluon's automatic update window, and certificate renewals Caddy will make.
 */

/** Plain names for timers every Debian/Ubuntu box has, and the usual suspects on home servers. */
const NAMES: [RegExp, string][] = [
  [/^apt-daily-upgrade$/, "Install security updates"],
  [/^apt-daily$/, "Check for system updates"],
  [/^unattended-upgrades?/, "Install security updates"],
  [/^logrotate$/, "Tidy up log files"],
  [/^fstrim$/, "Trim SSDs"],
  [/^e2scrub_all$/, "Check disks for errors"],
  [/^e2scrub_reap$/, "Clean up after disk checks"],
  [/^man-db$/, "Rebuild the manual index"],
  [/^dpkg-db-backup$/, "Back up the installed-package list"],
  [/^systemd-tmpfiles-clean$/, "Clear old temporary files"],
  [/^certbot/, "Renew certificates"],
  [/^snap\.certbot/, "Renew certificates"],
  [/^docker-(image-)?prune|^docker-cleanup/, "Clean up unused Docker images"],
  [/^snapd\.refresh/, "Update snaps"],
  [/^snapd\.snap-repair/, "Check snaps for repairs"],
  [/^fwupd-refresh$/, "Check for firmware updates"],
  [/^phpsessionclean$/, "Clear old PHP sessions"],
  [/^motd-news$/, "Fetch login news"],
  [/^update-notifier-download$/, "Download pending updates"],
  [/^update-notifier-motd$/, "Check for a new release"],
  [/^ua-timer$|^ubuntu-advantage/, "Check Ubuntu Pro status"],
  [/^apport-autoreport$/, "Send crash reports"],
  [/^plocate-updatedb$|^mlocate$|^updatedb$/, "Index files for search"],
  [/^sysstat-collect$/, "Record system activity"],
  [/^sysstat-summary$/, "Summarise system activity"],
  [/^sysstat-rotate$/, "Tidy up activity records"],
  [/^zfs-scrub|^zpool-scrub/, "Check ZFS pools for errors"],
  [/^zfs-trim/, "Trim ZFS pools"],
  [/^btrfs-scrub/, "Check Btrfs for errors"],
  [/^btrfs-balance/, "Rebalance Btrfs"],
  [/^mdcheck_start$|^mdcheck_continue$|^raid-check$/, "Check the RAID array"],
  [/^mdmonitor-oneshot$/, "Check the RAID array's health"],
  [/^smartd|^smartmontools/, "Check drive health"],
  [/^shadow$/, "Check user accounts"],
  [/^exim4-base$/, "Tidy the mail queue"],
  [/^anacron$/, "Run missed daily jobs"],
  [/^restic|^borg|^rsnapshot|^duplicati|^backup/i, "Back up"],
  [/^systemd-journal-/, "Tidy the system journal"],
  [/^packagekit-offline/, "Prepare offline updates"],
  [/^pamac|^pacman-filesdb-refresh$/, "Refresh the package database"],
  [/^geoipupdate$/, "Update the location database"],
  [/^rkhunter|^chkrootkit|^clamav/, "Scan for malware"],
  [/^casaos/i, "CasaOS housekeeping"],
];

const base = (unit: string) => unit.replace(/\.(timer|service)$/, "").replace(/@.*$/, "");

function niceName(unit: string, description: string | null): string {
  const b = base(unit);
  for (const [re, name] of NAMES) if (re.test(b)) return name;
  if (description) {
    // "Daily apt upgrade and clean activities" → as is, first letter up, no trailing dot or "Timer for".
    const d = description.replace(/^(Timer|Run|Trigger)( for)?\s+/i, "").replace(/\.$/, "").trim();
    if (d) return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return b;
}

interface Timer {
  unit: string;
  activates: string | null;
  next: number | null;
  last: number | null;
}

/** systemd ≥ 250: JSON with microsecond timestamps. */
function parseJson(stdout: string): Timer[] {
  const rows = JSON.parse(stdout) as { unit?: string; activates?: string; next?: number | null; last?: number | null }[];
  const us = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? Math.round(v / 1000) : null);
  return rows.filter((r) => typeof r.unit === "string").map((r) => ({ unit: r.unit!, activates: r.activates ?? null, next: us(r.next), last: us(r.last) }));
}

/**
 * Older systemd (no JSON): the plain table. Times there are the host's wall clock ("Tue 2026-09-29 00:35:14 CDT"), so
 * they're read with the host's current UTC offset (`date +%z`), which is right except across a DST change.
 */
function parsePlain(stdout: string, offsetMin: number): Timer[] {
  const out: Timer[] = [];
  const STAMP = /\b[A-Z][a-z]{2} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: \S+)?/g;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || !/\.timer\b/.test(t)) continue;
    const tokens = t.split(/\s+/);
    const unitAt = tokens.findIndex((x) => x.endsWith(".timer"));
    if (unitAt < 0) continue;
    const before = t.slice(0, t.indexOf(tokens[unitAt]!));
    const stamps = [...before.matchAll(STAMP)].map((m) => Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - offsetMin * 60_000);
    // NEXT is "-" or "n/a" for timers that won't fire again; then the only time on the line is LAST.
    const nextMissing = /^(-|n\/a)\s/.test(t);
    out.push({
      unit: tokens[unitAt]!,
      activates: tokens[unitAt + 1] ?? null,
      next: nextMissing ? null : (stamps[0] ?? null),
      last: nextMissing ? (stamps[0] ?? null) : (stamps[1] ?? null),
    });
  }
  return out;
}

async function listTimers(): Promise<Timer[]> {
  try {
    const { stdout } = await host("systemctl", ["list-timers", "--all", "--no-pager", "--output=json"], { timeoutMs: 6000, maxBuffer: 1024 * 1024 });
    if (stdout.trim().startsWith("[")) return parseJson(stdout);
  } catch {
    /* older systemd: fall through */
  }
  const [{ stdout }, zone] = await Promise.all([
    host("systemctl", ["list-timers", "--all", "--no-pager", "--no-legend"], { timeoutMs: 6000, maxBuffer: 1024 * 1024 }),
    host("date", ["+%z"], { timeoutMs: 3000 }).catch(() => ({ stdout: "+0000" })),
  ]);
  const m = /^([+-])(\d{2})(\d{2})/.exec(zone.stdout.trim());
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return parsePlain(stdout, offset);
}

/** Description and last result for each unit, in one call. */
async function describe(units: string[]): Promise<Map<string, { description: string | null; result: string | null }>> {
  const out = new Map<string, { description: string | null; result: string | null }>();
  if (!units.length) return out;
  const safe = units.filter((u) => /^[\w@.:\\-]+\.(service|timer)$/.test(u)).slice(0, 80);
  if (!safe.length) return out;
  try {
    const { stdout } = await host("systemctl", ["show", "--no-pager", "-p", "Id", "-p", "Description", "-p", "Result", "--", ...safe], { timeoutMs: 6000, maxBuffer: 1024 * 1024 });
    for (const block of stdout.split(/\n\s*\n/)) {
      const kv = Object.fromEntries(
        block
          .split("\n")
          .map((l) => l.split("="))
          .filter((p) => p.length >= 2)
          .map(([k, ...v]) => [k!.trim(), v.join("=").trim()]),
      );
      if (kv.Id) out.set(kv.Id, { description: kv.Description || null, result: kv.Result || null });
    }
  } catch {
    /* descriptions are a nicety */
  }
  return out;
}

async function systemItems(): Promise<ScheduleItem[]> {
  const timers = await listTimers();
  const info = await describe([...new Set(timers.flatMap((t) => [t.activates, t.unit].filter((x): x is string => !!x)))]);
  return timers
    .filter((t) => t.next !== null || t.last !== null)
    .map((t) => {
      const svc = t.activates ? info.get(t.activates) : undefined;
      const tim = info.get(t.unit);
      const result = svc?.result ?? null;
      return {
        id: `timer:${t.unit}`,
        name: niceName(t.unit, svc?.description ?? tim?.description ?? null),
        unit: t.unit,
        next: t.next,
        last: t.last,
        lastResult: t.last === null || !result ? null : result === "success" ? "success" : "failed",
        source: "system" as const,
        approx: false,
        detail: null,
      };
    });
}

/** Gluon's own automatic update window (server local time, as the updater checks it). */
function gluonItems(): ScheduleItem[] {
  const out: ScheduleItem[] = [];
  const u = getSetting("updates");
  if (u.auto && !(u.channel === "nightly" && u.nightlyTiming === "asap")) {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(u.hour);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    out.push({ id: "gluon:update", name: "Update Gluon if there's a new version", unit: null, next: d.getTime(), last: null, lastResult: null, source: "gluon", approx: true, detail: null });
  }
  return out;
}

/** Caddy renews a certificate once a third of its life is left. Reuses the last network check (up to 6 hours old). */
async function certificateItems(): Promise<ScheduleItem[]> {
  try {
    const mod = await import("../network/status");
    const status = await Promise.race([
      mod.networkStatus({ maxAgeMs: 6 * 3_600_000 }),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (!status) return [];
    const seen = new Map<string, number>();
    for (const r of status.routes) {
      const tls = r.tls;
      if (!r.enabled || !tls?.validTo || !tls.validFrom || (tls.status !== "ok" && tls.status !== "expiring")) continue;
      const to = Date.parse(tls.validTo);
      const from = Date.parse(tls.validFrom);
      if (!Number.isFinite(to) || !Number.isFinite(from)) continue;
      const renew = Math.max(Date.now(), to - (to - from) / 3);
      const prev = seen.get(r.host);
      if (prev === undefined || renew < prev) seen.set(r.host, renew);
    }
    return [...seen.entries()].map(([h, t]) => ({
      id: `cert:${h}`,
      name: "Renew a certificate",
      unit: null,
      next: t,
      last: null,
      lastResult: null,
      source: "certificate" as const,
      approx: true,
      detail: h,
    }));
  } catch {
    return [];
  }
}

export function scheduleAvailable(): { available: boolean; reason: string | null } {
  const ok = ["/usr/bin/systemctl", "/bin/systemctl", "/usr/local/bin/systemctl"].some((p) => hostExists(p));
  return ok ? { available: true, reason: null } : { available: false, reason: "This machine doesn't use systemd, so Gluon can't read its schedule." };
}

export async function scheduleData(): Promise<ScheduleData> {
  const avail = scheduleAvailable();
  if (!avail.available) return { available: false, reason: avail.reason! };
  const r = await cached(
    "home:schedule",
    60_000,
    async () => {
      const [system, certs] = await Promise.all([systemItems(), certificateItems()]);
      const items = [...system, ...gluonItems(), ...certs].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
      return { available: true as const, items, checkedAt: Date.now() };
    },
    { staleMs: 10 * 60_000 },
  );
  return r.value;
}
