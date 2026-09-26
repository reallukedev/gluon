import type { Prefs } from "./prefs";

export type FormatPrefs = Pick<Prefs, "bytes" | "temperature" | "rates" | "clock" | "dateOrder" | "timezone">;

const DEC = ["B", "kB", "MB", "GB", "TB", "PB"];
const BIN = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** 1_234_567 → "1.2 MB" (or "1.2 MiB"). Precision adapts so small values keep meaning. */
export function formatBytes(n: number | null | undefined, mode: "decimal" | "binary" = "decimal", digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const base = mode === "binary" ? 1024 : 1000;
  const units = mode === "binary" ? BIN : DEC;
  let v = Math.abs(n);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  const d = digits ?? (i === 0 ? 0 : v < 10 ? 1 : 0);
  return `${n < 0 ? "−" : ""}${v.toFixed(d)} ${units[i]}`;
}

/** Bytes per second → "4.2 MB/s" or "34 Mb/s". */
export function formatRate(bytesPerSec: number | null | undefined, mode: "bytes" | "bits" = "bytes"): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return "—";
  if (mode === "bits") {
    const units = ["b/s", "kb/s", "Mb/s", "Gb/s"];
    let v = bytesPerSec * 8;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }
  return `${formatBytes(bytesPerSec, "decimal")}/s`;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(v > 0 && v < 1 && digits === 0 ? 1 : digits)}%`;
}

export function formatTemp(celsius: number | null | undefined, unit: "c" | "f" = "c"): string {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return "—";
  return unit === "f" ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${Math.round(celsius)}°C`;
}

/** 5025 s → "1 h 23 m"; 42 s → "42 s"; 3 days → "3 d 4 h". */
export function formatDuration(seconds: number | null | undefined, parts = 2): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  let s = Math.max(0, Math.floor(seconds));
  const units: [string, number][] = [
    ["y", 365 * 86400],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  const out: string[] = [];
  for (const [u, n] of units) {
    if (s >= n || (u === "s" && out.length === 0)) {
      const q = Math.floor(s / n);
      s -= q * n;
      out.push(`${q} ${u}`);
      if (out.length >= parts) break;
    }
  }
  return out.join(" ");
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "long" }) : null;

/** "just now", "4 minutes ago", "in 2 days". */
export function formatRelative(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff < 0 ? "just now" : "in a moment";
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2629800],
    ["year", 31557600],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let div = 60;
  for (const [u, n] of table) {
    if (abs >= n) {
      unit = u;
      div = n;
    }
  }
  return rtf ? rtf.format(Math.round(diff / div), unit) : new Date(ts).toLocaleString();
}

function hour12(p?: Pick<FormatPrefs, "clock">): boolean | undefined {
  if (!p || p.clock === "auto") return undefined;
  return p.clock === "12";
}
function tz(p?: Pick<FormatPrefs, "timezone">): string | undefined {
  return p && p.timezone !== "auto" ? p.timezone : undefined;
}

export function formatTime(ts: number | Date, p?: Pick<FormatPrefs, "clock" | "timezone">, seconds = false): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: hour12(p),
    timeZone: tz(p),
  });
}

export function formatDate(ts: number | Date, p?: Pick<FormatPrefs, "dateOrder" | "timezone">, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const d = new Date(ts);
  if (p && p.dateOrder === "ymd") {
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz(p) }).format(d);
    return parts;
  }
  const locale = p?.dateOrder === "dmy" ? "en-GB" : p?.dateOrder === "mdy" ? "en-US" : undefined;
  return d.toLocaleDateString(locale, {
    weekday: opts.weekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: opts.year ? "numeric" : undefined,
    timeZone: tz(p),
  });
}

export function formatDateTime(ts: number, p?: FormatPrefs): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `Today ${formatTime(ts, p)}` : `${formatDate(ts, p)}, ${formatTime(ts, p)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "a, b and c" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
