import "server-only";
import { findContainer, containerLogLines } from "../diagnostics/docker-logs";
import type { DdnsLogLine, DdnsStatus } from "@/lib/network-types";

/**
 * favonia/cloudflare-ddns status, read from `docker logs cloudflare-ddns` (emoji-prefixed lines) and
 * `docker inspect` (DOMAINS / PROXIED …). The API token in its environment is never read out.
 *
 *   🌐 Detected IPv4 address: 203.0.113.7
 *   🌐 Detected 2 IPv6 addresses: 2600:…::35/64, 2600:…:d5b8/64
 *   🤷 The A records for x are already up to date (cached)
 *   🐣 Added a new A record for x (ID: …)      📡 Updated …      🗑️ Deleted …
 *   ⏰ Checking the IP addresses in about 5m0s . . .
 *   😡/😩/😞/🤯 … failures;  🤔/⚠️ hints
 */

const CONTAINER = (process.env.GLUON_DDNS_CONTAINER ?? process.env.TEND_DDNS_CONTAINER) ?? "cloudflare-ddns";
const ENV_KEYS = ["DOMAINS", "IP4_DOMAINS", "IP6_DOMAINS", "PROXIED", "IP4_PROVIDER", "IP6_PROVIDER", "UPDATE_CRON"] as const;

const ERROR_EMOJI = ["😡", "😩", "😞", "🤯", "😤", "❌", "💀", "🙀", "😰", "😱", "😖", "🚫", "😵"];
const WARN_EMOJI = ["🤔", "⚠️", "⚠", "😦", "🙁", "😐", "😮"];
const UPDATE_EMOJI = ["🐣", "📡", "🗑️", "🗑"];
const ERROR_WORDS = /\b(fail(?:ed|ure|s)?|error|could ?n[o']t|unable|invalid|denied|unauthori[sz]ed|forbidden|timed? ?out)\b/i;

interface Parsed {
  at: number | null;
  text: string;
}

function splitTimestamp(line: string): Parsed {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/);
  if (!m) return { at: null, text: line };
  const at = Date.parse(m[1]!);
  return { at: Number.isFinite(at) ? at : null, text: m[2]! };
}

export function classify(text: string): DdnsLogLine["level"] {
  const t = text.trim();
  if (t.startsWith("🔸") || t.startsWith("🔧") || t.startsWith("📖") || t.startsWith("🧪")) return "info";
  if (ERROR_EMOJI.some((e) => t.startsWith(e))) return "error";
  if (UPDATE_EMOJI.some((e) => t.startsWith(e))) return "update";
  if (WARN_EMOJI.some((e) => t.startsWith(e))) return "warning";
  if (ERROR_WORDS.test(t) && !t.startsWith("🤷") && !t.startsWith("🌐")) return "error";
  return "info";
}

const stripEmoji = (t: string) => t.replace(/^[^\p{L}\p{N}(*"']+/u, "").trim();

const split = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// ---------------------------------------------------------------- PROXIED expression

/**
 * Evaluate favonia's PROXIED expression for one domain: true | false | is(d…) | sub(d…) | ! | && | ||
 * and parentheses. Returns null if the expression uses something we don't understand.
 */
export function evalProxied(expr: string, domain: string): boolean | null {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[^\s()!&|,]+|,/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const d = domain.toLowerCase().replace(/\.$/, "");
  const matchIs = (names: string[]) => names.some((n) => n === d);
  const matchSub = (names: string[]) => names.some((n) => d.endsWith(`.${n}`));
  function args(): string[] {
    if (next() !== "(") throw new Error("expected (");
    const out: string[] = [];
    while (peek() !== undefined && peek() !== ")") {
      const t = next()!;
      if (t !== ",") out.push(t.toLowerCase().replace(/\.$/, ""));
    }
    if (next() !== ")") throw new Error("expected )");
    return out;
  }
  function primary(): boolean {
    const t = next();
    if (t === undefined) throw new Error("unexpected end");
    if (t === "!") return !primary();
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error("expected )");
      return v;
    }
    const low = t.toLowerCase();
    if (low === "true") return true;
    if (low === "false") return false;
    if (low === "is") return matchIs(args());
    if (low === "sub") return matchSub(args());
    throw new Error(`unknown ${t}`);
  }
  function and(): boolean {
    let v = primary();
    while (peek() === "&&") {
      next();
      const r = primary();
      v = v && r;
    }
    return v;
  }
  function or(): boolean {
    let v = and();
    while (peek() === "||") {
      next();
      const r = and();
      v = v || r;
    }
    return v;
  }
  try {
    const v = or();
    return i === tokens.length ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- status

type G = typeof globalThis & { __gluonDdns?: { at: number; value: Promise<DdnsStatus> } };
const g = globalThis as G;

/** Parse ddns log lines (with Docker timestamps) into the moving parts of the status. */
export function parseDdnsLog(lines: string[]) {
  const parsed = lines.map(splitTimestamp).filter((p) => p.text.trim());
  let ipv4: DdnsStatus["ipv4"] = null;
  let ipv6: DdnsStatus["ipv6"] = null;
  let lastChange: DdnsStatus["lastChange"] = null;
  let lastCheckAt: number | null = null;
  let version: string | null = null;
  let proxiedDomains: string[] = [];
  let unproxiedDomains: string[] = [];
  const ticks: number[] = []; // indexes of "⏰ Checking…" lines
  const recent: DdnsLogLine[] = [];

  for (const [idx, p] of parsed.entries()) {
    const t = p.text.trim();
    const v4 = t.match(/Detected IPv4 address:?\s*([0-9.]+)/i);
    if (v4) ipv4 = { address: v4[1]!, at: p.at };
    const v6 = t.match(/Detected (?:\d+ )?IPv6 address(?:es)?:?\s*(.+)$/i);
    if (v6) ipv6 = { addresses: v6[1]!.split(/,\s*/).map((a) => a.replace(/\/\d+$/, "").trim()).filter(Boolean), at: p.at };
    if (/^🌐|^🤷|^🐣|^📡|^🗑/.test(t)) lastCheckAt = p.at ?? lastCheckAt;
    if (UPDATE_EMOJI.some((e) => t.startsWith(e))) lastChange = { at: p.at, message: stripEmoji(t) };
    if (t.startsWith("⏰")) ticks.push(idx);
    const ver = t.match(/Cloudflare DDNS \(v?([^)]+)\)/);
    if (ver) version = ver[1]!.replace(/-0-g[0-9a-f]+$/, "");
    const pd = t.match(/^🔸\s*Proxied domains:\s*(.+)$/);
    if (pd) proxiedDomains = pd[1]!.includes("(none)") ? [] : pd[1]!.split(/,\s*/).map((s) => s.trim().toLowerCase());
    const ud = t.match(/^🔸\s*Unproxied domains:\s*(.+)$/);
    if (ud) unproxiedDomains = ud[1]!.includes("(none)") ? [] : ud[1]!.split(/,\s*/).map((s) => s.trim().toLowerCase());
  }

  // Errors that matter: the last completed check cycle plus anything after it.
  const from = ticks.length >= 2 ? ticks[ticks.length - 2]! + 1 : 0;
  const errors: DdnsLogLine[] = [];
  for (const [idx, p] of parsed.entries()) {
    const level = classify(p.text);
    const line: DdnsLogLine = { at: p.at, level, message: stripEmoji(p.text) };
    if (level === "error" && idx >= from) errors.push(line);
    const t = p.text.trim();
    // Keep the log readable: skip the settings dump and blank noise.
    if (!/^(🔸|🔧|📖|🧪)/.test(t)) recent.push(line);
  }
  // A restart ("🚨 Caught signal", "👋 Bye") isn't an error.
  return { ipv4, ipv6, lastChange, lastCheckAt, version, proxiedDomains, unproxiedDomains, errors, recent: recent.slice(-60) };
}

async function build(): Promise<DdnsStatus> {
  const found = await findContainer(CONTAINER, (c) => /cloudflare-ddns/.test(c.Image));
  const empty: DdnsStatus = {
    container: { exists: false, name: CONTAINER, state: null, running: false, startedAt: null, image: null, version: null, project: null },
    config: { domains: [], ip4Domains: [], ip6Domains: [], proxied: null, proxiedDomains: [], unproxiedDomains: [], ip4Provider: null, ip6Provider: null, updateSchedule: null },
    ipv4: null,
    ipv6: null,
    lastCheckAt: null,
    lastChange: null,
    errors: [],
    recent: [],
    summary: "No dynamic DNS container found, so Gluon can't tell whether DNS follows this network's address.",
    state: "unknown",
  };
  if (!found) return empty;

  const env = new Map<string, string>();
  for (const e of found.info.Config.Env ?? []) {
    const i = e.indexOf("=");
    const k = e.slice(0, i);
    if ((ENV_KEYS as readonly string[]).includes(k)) env.set(k, e.slice(i + 1));
  }
  let lines: string[] = [];
  try {
    lines = await containerLogLines(found, { tail: 1500, timestamps: true });
  } catch {
    lines = [];
  }
  const log = parseDdnsLog(lines);

  const domains = split(env.get("DOMAINS"));
  const ip4Only = split(env.get("IP4_DOMAINS"));
  const ip6Only = split(env.get("IP6_DOMAINS"));
  const proxied = env.get("PROXIED") ?? null;
  const all = [...new Set([...domains, ...ip4Only, ...ip6Only])];
  let proxiedDomains = log.proxiedDomains;
  let unproxiedDomains = log.unproxiedDomains;
  if (!proxiedDomains.length && !unproxiedDomains.length) {
    const p = all.filter((d) => (proxied ? evalProxied(proxied, d) === true : false));
    proxiedDomains = p;
    unproxiedDomains = all.filter((d) => !p.includes(d));
  }

  const running = !!found.info.State.Running;
  let state: DdnsStatus["state"] = "ok";
  let summary: string;
  const v4 = log.ipv4;
  if (!running) {
    state = "fault";
    summary = `The dynamic DNS updater (${found.name}) isn't running, so DNS won't follow if your internet address changes.`;
  } else if (log.errors.length) {
    state = "attention";
    summary = `The dynamic DNS updater reported ${log.errors.length === 1 ? "a problem" : `${log.errors.length} problems`} on its last check: ${log.errors.at(-1)!.message}`;
  } else if (v4) {
    const cron = env.get("UPDATE_CRON") ?? "@every 5m";
    const every = cron.startsWith("@every") ? `every ${cron.replace(/^@every\s*/, "").replace(/(\d)m0s$/, "$1m").replace(/^(\d+)m$/, "$1 minutes").replace(/^(\d+)h$/, "$1 hours")}` : `on the schedule “${cron}”`;
    const n6 = log.ipv6?.addresses.length ?? 0;
    summary = `DNS is kept pointed at ${v4.address}${n6 ? ` and ${n6} IPv6 address${n6 === 1 ? "" : "es"}` : ""}, checked ${every}.`;
  } else {
    state = "unknown";
    summary = "The dynamic DNS updater is running but hasn't reported an address in its recent log.";
  }

  return {
    container: {
      exists: true,
      name: found.name,
      state: found.info.State.Status ?? null,
      running,
      startedAt: found.info.State.StartedAt ?? null,
      image: found.info.Config.Image ?? null,
      version: log.version,
      project: found.info.Config.Labels?.["com.docker.compose.project"] ?? null,
    },
    config: {
      domains,
      ip4Domains: ip4Only,
      ip6Domains: ip6Only,
      proxied,
      proxiedDomains,
      unproxiedDomains,
      ip4Provider: env.get("IP4_PROVIDER") ?? "cloudflare.trace",
      ip6Provider: env.get("IP6_PROVIDER") ?? "cloudflare.trace",
      updateSchedule: env.get("UPDATE_CRON") ?? "@every 5m",
    },
    ipv4: v4,
    ipv6: log.ipv6,
    lastCheckAt: log.lastCheckAt,
    lastChange: log.lastChange,
    errors: log.errors.slice(-10),
    recent: log.recent,
    summary,
    state,
  };
}

/** DDNS status, cached 30 s. */
export function ddnsStatus(force = false): Promise<DdnsStatus> {
  const c = g.__gluonDdns;
  if (!force && c && Date.now() - c.at < 30_000) return c.value;
  const value = build();
  g.__gluonDdns = { at: Date.now(), value };
  value.catch(() => {
    if (g.__gluonDdns?.value === value) g.__gluonDdns = undefined;
  });
  return value;
}
