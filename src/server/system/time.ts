import "server-only";
import fs from "node:fs";
import { host, CommandError } from "../host/exec";
import { hostPath, readHostFileOr } from "../host/paths";
import { AppError, badRequest } from "../errors";
import type { TimeStatus } from "@/lib/system-types";
import { parseShow } from "./units";

/** Clock, timezone, NTP and hostname: small settings that change the host. */

export async function timeStatus(): Promise<TimeStatus> {
  let r: Record<string, string> = {};
  try {
    const { stdout } = await host("timedatectl", ["show"], {
      timeoutMs: 10_000,
    });
    r = parseShow(stdout)[0] ?? {};
  } catch {
    /* timedated unavailable: fall back to /etc/localtime */
  }
  let server: string | null = null;
  if (r.NTP === "yes") {
    try {
      const { stdout } = await host("timedatectl", ["show-timesync", "-p", "ServerName", "--value"], { timeoutMs: 5000 });
      server = stdout.trim() || null;
    } catch {
      /* chrony/ntpsec, or timesyncd not running */
    }
  }
  let timezone = r.Timezone || null;
  if (!timezone) {
    try {
      timezone = fs.readlinkSync(hostPath("/etc/localtime")).replace(/^.*zoneinfo\//, "") || null;
    } catch {
      timezone = readHostFileOr("/etc/timezone", "").trim() || null;
    }
  }
  const yn = (v: string | undefined) => (v === "yes" ? true : v === "no" ? false : null);
  return {
    timezone,
    ntp: yn(r.NTP),
    synced: yn(r.NTPSynchronized),
    canNtp: yn(r.CanNTP),
    localRtc: yn(r.LocalRTC),
    now: Date.now(),
    server,
  };
}

type G = typeof globalThis & {
  __gluonTimezones?: { at: number; list: string[] };
};
const g = globalThis as G;

export async function listTimezones(): Promise<string[]> {
  const c = g.__gluonTimezones;
  if (c && Date.now() - c.at < 3_600_000) return c.list;
  const { stdout } = await host("timedatectl", ["list-timezones", "--no-pager"], { timeoutMs: 15_000 });
  const list = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_+\-/]+$/.test(s));
  g.__gluonTimezones = { at: Date.now(), list };
  return list;
}

export async function setTimezone(tz: string): Promise<void> {
  const list = await listTimezones();
  if (!list.includes(tz)) throw badRequest(`${tz.slice(0, 60)} isn't a timezone this server knows.`);
  await host("timedatectl", ["set-timezone", tz], { timeoutMs: 20_000 });
}

export async function setNtp(enabled: boolean): Promise<void> {
  const s = await timeStatus();
  if (enabled && s.canNtp === false) {
    throw new AppError("no_ntp", "No time-sync service is installed, so automatic time can't be turned on. Install systemd-timesyncd or chrony.", 409);
  }
  try {
    await host("timedatectl", ["set-ntp", enabled ? "true" : "false"], {
      timeoutMs: 20_000,
    });
  } catch (e) {
    if (e instanceof CommandError && /NTP not supported/i.test(e.stderr)) {
      throw new AppError("no_ntp", "No time-sync service is installed, so automatic time can't be changed.", 409);
    }
    throw e;
  }
}

// ---------------------------------------------------------------- hostname

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** RFC 1123 hostname (letters, digits, hyphens; dot-separated labels ≤ 63; total ≤ 253). */
export function validateHostname(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!name) throw badRequest("Enter a name for the server.");
  if (name.length > 253) throw badRequest("That name is too long (253 characters at most).");
  const labels = name.split(".");
  for (const l of labels) {
    if (!l) throw badRequest("A name can't have two dots in a row or start with a dot.");
    if (l.length > 63) throw badRequest("Each part of the name can be 63 characters at most.");
    if (!LABEL.test(l)) throw badRequest("Use only letters, digits and hyphens, and don't start or end with a hyphen.");
  }
  if (/^\d+$/.test(labels[0]!)) throw badRequest("The name can't be only digits.");
  if (name === "localhost") throw badRequest("Choose a name other than localhost.");
  return name;
}

export async function currentHostname(): Promise<string> {
  try {
    const { stdout } = await host("hostname", [], { timeoutMs: 5000 });
    return stdout.trim();
  } catch {
    return readHostFileOr("/etc/hostname", "").trim();
  }
}

/**
 * Rewrite /etc/hosts so the new name resolves locally (Debian maps it on the 127.0.1.1 line;
 * without that `sudo` complains "unable to resolve host"). Returns the previous contents so the
 * caller can roll back, or null when nothing changed.
 */
function updateEtcHosts(oldName: string, newName: string): string | null {
  const file = hostPath("/etc/hosts");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const oldShort = oldName.split(".")[0]!;
  const newShort = newName.split(".")[0]!;
  const lines = text.split("\n");
  let changed = false;
  let has127011 = false;
  const next = lines.map((line) => {
    const [content, ...comment] = line.split("#");
    const fields = content!.trim().split(/\s+/);
    if (fields[0] !== "127.0.1.1") return line;
    has127011 = true;
    const names = fields.slice(1).map((n) => (n === oldName ? newName : n === oldShort ? newShort : n));
    if (!names.includes(newName) && !names.includes(newShort)) names.unshift(newName);
    const deduped = [...new Set(names)];
    const rebuilt = `127.0.1.1\t${deduped.join(" ")}${comment.length ? ` #${comment.join("#")}` : ""}`;
    if (rebuilt !== line) changed = true;
    return rebuilt;
  });
  if (!has127011) {
    const at = next.findIndex((l) => /^127\.0\.0\.1\s/.test(l));
    next.splice(at >= 0 ? at + 1 : 0, 0, `127.0.1.1\t${newName}${newShort !== newName ? ` ${newShort}` : ""}`);
    changed = true;
  }
  if (!changed) return null;
  const st = fs.statSync(file);
  fs.writeFileSync(hostPath("/etc/hosts.gluon-backup"), text, {
    mode: st.mode & 0o777,
  });
  const tmp = hostPath("/etc/.hosts.gluon-tmp");
  fs.writeFileSync(tmp, next.join("\n"), { mode: st.mode & 0o777 });
  fs.renameSync(tmp, file);
  return text;
}

export async function setHostname(raw: string): Promise<{ hostname: string; previous: string; message: string }> {
  const name = validateHostname(raw);
  const previous = await currentHostname();
  if (previous === name)
    return {
      hostname: name,
      previous,
      message: `The server is already called ${name}.`,
    };
  const backup = updateEtcHosts(previous, name);
  try {
    await host("hostnamectl", ["set-hostname", name], { timeoutMs: 20_000 });
  } catch (e) {
    if (backup !== null) {
      try {
        fs.writeFileSync(hostPath("/etc/hosts"), backup);
      } catch {
        /* keep the backup file for manual recovery */
      }
    }
    throw new AppError("hostname_failed", "The server's name couldn't be changed. Nothing was changed.", 500, { error: (e as Error).message });
  }
  return {
    hostname: name,
    previous,
    message: `Renamed the server from ${previous} to ${name}. Samba and other apps that show the name pick it up after they restart. Addresses like ${previous}.local stop working.`,
  };
}
