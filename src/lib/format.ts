import type { Prefs } from "./prefs";

export type FormatPrefs = Pick<Prefs, "bytes" | "temperature" | "rates" | "clock" | "dateOrder" | "timezone">;

const DEC = ["B", "kB", "MB", "GB", "TB", "PB"];
const BIN = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** 1_234_567 → "1.2 MB" (or "1.2 MiB"). Precision adapts so small values keep meaning. */
export function formatBytes(n: number | null | undefined, mode: "decimal" | "binary" = "decimal", digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Unknown";
  const base = mode === "binary" ? 1024 : 1000;
  const units = mode === "binary" ? BIN : DEC;
  let v = Math.abs(n);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  let d = digits ?? (i === 0 ? 0 : v < 10 ? 1 : 0);
  // 999.7 kB would print as "1000 kB": step up a unit when rounding reaches the base.
  if (Number(v.toFixed(d)) >= base && i < units.length - 1) {
    v /= base;
    i++;
    d = digits ?? 1;
  }
  return `${n < 0 ? "−" : ""}${v.toFixed(d)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number | null | undefined, mode: "bytes" | "bits" = "bytes"): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return "Unknown";
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
  if (v === null || v === undefined || !Number.isFinite(v)) return "Unknown";
  const d = v > 0 && v < 1 && digits === 0 ? 1 : digits;
  const text = v.toFixed(d);
  // A drive at 99.6% isn't full and one at 0.04% isn't empty: rounding must not reach either end.
  if (v < 100 && Number(text) >= 100) return `${(Math.floor(v * 10 ** d) / 10 ** d).toFixed(d)}%`;
  if (v > 0 && Number(text) === 0) return `<${(1 / 10 ** Math.max(d, 1)).toFixed(Math.max(d, 1))}%`;
  return `${text}%`;
}

export function formatTemp(celsius: number | null | undefined, unit: "c" | "f" = "c"): string {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return "Unknown";
  return unit === "f" ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${Math.round(celsius)}°C`;
}

export function formatDuration(seconds: number | null | undefined, parts = 2): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "Unknown";
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

/*
 * Building a formatter costs about 100 times more than using one, and a long table formats a time
 * or two per row, so formatters are kept per locale and options.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(locale: string | undefined, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(o)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, o);
    formatters.set(key, f);
  }
  return f;
}

export function formatTime(ts: number | Date, p?: Pick<FormatPrefs, "clock" | "timezone">, seconds = false): string {
  if (!Number.isFinite(+ts)) return "Unknown";
  return dateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: hour12(p),
    timeZone: tz(p),
  }).format(new Date(ts));
}

export function formatDate(ts: number | Date, p?: Pick<FormatPrefs, "dateOrder" | "timezone">, opts: { year?: boolean; weekday?: boolean } = {}): string {
  if (!Number.isFinite(+ts)) return "Unknown";
  const d = new Date(ts);
  if (p && p.dateOrder === "ymd") return dateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz(p) }).format(d);
  const locale = p?.dateOrder === "dmy" ? "en-GB" : p?.dateOrder === "mdy" ? "en-US" : undefined;
  return dateTimeFormat(locale, {
    weekday: opts.weekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: opts.year ? "numeric" : undefined,
    timeZone: tz(p),
  }).format(d);
}

function dayKey(ts: number, p?: Pick<FormatPrefs, "timezone">): string {
  return dateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz(p) }).format(ts);
}

export function formatDateTime(ts: number, p?: FormatPrefs, now = Date.now()): string {
  if (!Number.isFinite(ts)) return "Unknown";
  // "Today" is decided in the zone the time is shown in, not the machine's own, or it's wrong near midnight.
  const sameDay = dayKey(ts, p) === dayKey(now, p);
  return sameDay ? `Today ${formatTime(ts, p)}` : `${formatDate(ts, p)}, ${formatTime(ts, p)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
