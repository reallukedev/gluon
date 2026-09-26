import "server-only";

/** A time zone: an IANA name (via Intl) or a fixed offset (for calendars with unknown custom zones). */
export type Zone = { kind: "iana"; name: string } | { kind: "fixed"; offsetMs: number };

export const UTC: Zone = { kind: "iana", name: "UTC" };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isIanaZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

export interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

function ianaParts(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour === 24 ? 0 : p.hour!, mi: p.minute!, s: p.second! };
}

const wallMs = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);

function offsetAt(ms: number, zone: Zone): number {
  if (zone.kind === "fixed") return zone.offsetMs;
  const floored = Math.floor(ms / 1000) * 1000;
  return wallMs(ianaParts(floored, zone.name)) - floored;
}

/** Wall-clock time in a zone → UTC instant. Times in a DST gap move forward; ambiguous ones take the first. */
export function zonedToUtc(w: Wall, zone: Zone): number {
  const wall = wallMs(w);
  const off1 = offsetAt(wall, zone);
  let t = wall - off1;
  const off2 = offsetAt(t, zone);
  if (off2 !== off1) t = wall - off2;
  return t;
}

export function utcToWall(ms: number, zone: Zone): Wall {
  if (zone.kind === "fixed") {
    const d = new Date(ms + zone.offsetMs);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  return ianaParts(ms, zone.name);
}

/** Days since epoch for a calendar date (zone-free arithmetic). */
export const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
export function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
/** 0 = Sunday … 6 = Saturday */
export const weekday = (dayNum: number) => (((dayNum + 4) % 7) + 7) % 7;
export const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Common Windows zone names used by Outlook/Exchange calendars. */
const WINDOWS: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Israel Standard Time": "Asia/Jerusalem",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Arabian Standard Time": "Asia/Dubai",
  "Iran Standard Time": "Asia/Tehran",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Singapore Standard Time": "Asia/Singapore",
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "W. Australia Standard Time": "Australia/Perth",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "Eastern Standard Time": "America/New_York",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
};

/** Resolve a TZID from a calendar: IANA names, "/mozilla.org/…/Europe/Berlin" prefixes, Windows names. */
export function resolveTzid(tzid: string | undefined | null): Zone | null {
  if (!tzid) return null;
  const t = tzid.trim().replace(/^"|"$/g, "");
  if (isIanaZone(t)) return { kind: "iana", name: t };
  if (WINDOWS[t]) return { kind: "iana", name: WINDOWS[t]! };
  const tail = /([A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?)$/.exec(t)?.[1];
  if (tail && isIanaZone(tail)) return { kind: "iana", name: tail };
  const off = /^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(t);
  if (off) return { kind: "fixed", offsetMs: (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0)) * 60_000 };
  return null;
}

export function zoneName(z: Zone): string {
  if (z.kind === "iana") return z.name;
  const mins = z.offsetMs / 60_000;
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
