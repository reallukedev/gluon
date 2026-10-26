import "server-only";
import fs from "node:fs";
import crypto from "node:crypto";
import dns from "node:dns";
import { host, CommandError } from "../host/exec";
import { hostPath, readHostFileOr } from "../host/paths";
import { isHomeIp } from "../net-zone";
import { AppError, notFound } from "../errors";
import type { FailedAttempts, LiveLogins, LiveSession, LoginMethod, LoginZone, SessionKind, SignInHistory, SignInLane, SignInSource, SignInSpan, SshPosture } from "@/lib/system-types";
import { listServices } from "./services";

/**
 * Who is signed in to the machine (SSH and the local console), recent sign-ins and failed
 * attempts, and how SSH is set up. Everything here is read-only except `endSession`.
 *
 * Sources:
 *  - live sessions: logind (`loginctl`), the session's cgroup for its processes, /proc for what's
 *    in the foreground, `ss` for the client's port, /dev/pts atime for idle time;
 *  - history: sshd's journal entries, read once for 7 days and then incrementally by cursor;
 *    wtmp (`last`) adds console sign-ins and stands in when the journal has nothing;
 *  - posture: `sshd -T`, the effective configuration.
 */

const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const CLK_TCK = 100;

// ---------------------------------------------------------------- small helpers

const normIp = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  let a = ip.trim().replace(/^\[|\]$/g, "");
  if (a.startsWith("::ffff:")) a = a.slice(7);
  return a || null;
};

const LOOPBACK = /^(127\.|::1$)/;

export function zoneOf(ip: string | null): LoginZone {
  if (!ip || LOOPBACK.test(ip)) return "local";
  return isHomeIp(ip) ? "home" : "away";
}

function bootTimeMs(): number {
  const btime = readHostFileOr("/proc/stat", "").match(/^btime (\d+)/m)?.[1];
  return btime ? Number(btime) * 1000 : 0;
}

function currentBootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/-/g, "");
  } catch {
    return "";
  }
}

interface ProcStat {
  pid: number;
  comm: string;
  ppid: number;
  tpgid: number;
  startMs: number;
}

/** /proc/<pid>/stat. With `pid: host` this container's /proc is the host's. */
function procStat(pid: number, boot: number): ProcStat | null {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const comm = text.slice(open + 1, close);
  const f = text.slice(close + 2).split(" ");
  // f[0] = state (field 3); ppid = field 4, tpgid = field 8, starttime = field 22.
  return {
    pid,
    comm,
    ppid: Number(f[1]),
    tpgid: Number(f[5]),
    startMs: boot + (Number(f[19]) / CLK_TCK) * 1000,
  };
}

/** The process title (sshd rewrites it to "sshd-session: luke@pts/0"). Only argv[0]. */
function procTitle(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- reverse DNS (cached, bounded)

type G = typeof globalThis & {
  __gluonRdnsV2?: Map<string, { at: number; host: string | null }>;
  __gluonSignins?: JournalState;
  __gluonAuthKeysV2?: Map<string, { at: number; keys: Map<string, string> }>;
  __gluonPosture?: {
    at: number;
    posture: Omit<SshPosture, "seenFromOutside" | "blocker" | "running" | "unit">;
  };
  __gluonLiveLogins?: {
    at: number;
    data: LiveLogins;
    pending?: Promise<LiveLogins>;
  };
};
const g = globalThis as G;

const resolver = new dns.promises.Resolver({ timeout: 1200, tries: 1 });

async function reverse(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const cache = (g.__gluonRdnsV2 ??= new Map());
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < (hit.host ? 6 : 1) * 3_600_000) return hit.host;
  let name: string | null = null;
  try {
    const names = await resolver.reverse(ip);
    name = names[0]?.replace(/\.$/, "") || null;
    // Names that say nothing to a person: random device ids, "localhost" aliases, the address itself.
    if (name && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.|$)/i.test(name) || /^(ip6-)?localhost/i.test(name) || name === ip)) name = null;
  } catch {
    name = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(ip, { at: Date.now(), host: name });
  return name;
}

async function reverseMany(ips: (string | null)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ips.filter((x): x is string => !!x))].slice(0, 40);
  const out = new Map<string, string | null>();
  await Promise.all(unique.map(async (ip) => out.set(ip, await reverse(ip))));
  return out;
}

// ---------------------------------------------------------------- accounts and their keys

function passwdUsers(): Map<string, { uid: number; home: string }> {
  const out = new Map<string, { uid: number; home: string }>();
  for (const line of readHostFileOr("/etc/passwd", "").split("\n")) {
    const [name, , uid, , , home] = line.split(":");
    if (name && home) out.set(name, { uid: Number(uid), home });
  }
  return out;
}

const KEY_TYPE = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+@openssh\.com)$/;

/** SHA256 fingerprint → comment for every key in a user's authorized_keys. */
function authorizedKeys(user: string, home: string): Map<string, string> {
  const cache = (g.__gluonAuthKeysV2 ??= new Map());
  const hit = cache.get(user);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.keys;
  const keys = new Map<string, string>();
  for (const file of ["authorized_keys", "authorized_keys2"]) {
    let text = "";
    try {
      text = readHostFileOr(`${home.replace(/\/$/, "")}/.ssh/${file}`, "");
    } catch {
      text = "";
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Options may come first ("from=…,no-pty ssh-ed25519 AAAA… comment"); find the key type.
      const parts = line.match(/(?:"[^"]*"|\S)+/g) ?? [];
      const i = parts.findIndex((p) => KEY_TYPE.test(p));
      if (i < 0 || !parts[i + 1]) continue;
      try {
        const blob = Buffer.from(parts[i + 1]!, "base64");
        if (!blob.length) continue;
        const fp = `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
        const comment = parts
          .slice(i + 2)
          .join(" ")
          .trim();
        if (comment) keys.set(fp, comment.slice(0, 80));
      } catch {
        /* not base64 */
      }
    }
  }
  cache.set(user, { at: Date.now(), keys });
  return keys;
}

function keyLabel(user: string, fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  const home = passwdUsers().get(user)?.home;
  if (!home) return null;
  return authorizedKeys(user, home).get(fingerprint) ?? null;
}

// ---------------------------------------------------------------- journal: sign-ins and failures

interface SessionRec {
  key: string;
  boot: string;
  pid: number;
  user: string;
  ip: string | null;
  port: number | null;
  method: LoginMethod;
  fingerprint: string | null;
  start: number;
  end: number | null;
}

interface FailRec {
  t: number;
  ip: string;
  user: string;
  invalid: boolean;
}

interface JournalState {
  cursor: string | null;
  loadedAt: number;
  sessions: Map<string, SessionRec>;
  fails: FailRec[];
  /** "boot:pid" of an "Invalid user" line not yet followed by a "Failed … invalid user" line. */
  pendingInvalid: Map<string, number>;
  oldest: number | null;
  grep: boolean;
  ok: boolean;
  pending?: Promise<void>;
}

const ACCEPTED = /^Accepted (\S+) for (\S+) from (\S+) port (\d+)(?: ssh\d)?(?:: \S+ (SHA256:\S+))?/;
const CLOSED = /^pam_unix\(sshd:session\): session closed for user (\S+)/;
const DISCONNECTED = /^Disconnected from user (\S+) (\S+) port (\d+)/;
const FAILED = /^Failed (\S+) for (invalid user )?(.*?) from (\S+) port (\d+)/;
const INVALID = /^Invalid user (.*?) from (\S+) port (\d+)/;
const GREP = "^(Accepted |Failed |Invalid user |Disconnected from user |pam_unix\\(sshd:session\\): session closed)";

function methodOf(m: string): LoginMethod {
  if (m === "publickey") return "key";
  if (m === "password") return "password";
  if (m === "keyboard-interactive/pam" || m === "keyboard-interactive") return "keyboard";
  return "other";
}

function state(): JournalState {
  return (g.__gluonSignins ??= {
    cursor: null,
    loadedAt: 0,
    sessions: new Map(),
    fails: [],
    pendingInvalid: new Map(),
    oldest: null,
    grep: true,
    ok: false,
  });
}

function ingest(st: JournalState, line: string) {
  let e: {
    MESSAGE?: unknown;
    _PID?: string;
    _BOOT_ID?: string;
    __REALTIME_TIMESTAMP?: string;
    __CURSOR?: string;
  };
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.__CURSOR) st.cursor = e.__CURSOR;
  const msg = typeof e.MESSAGE === "string" ? e.MESSAGE : Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE as number[]).toString("utf8") : "";
  if (!msg) return;
  const t = Math.floor(Number(e.__REALTIME_TIMESTAMP ?? 0) / 1000);
  if (!t) return;
  const boot = e._BOOT_ID ?? "";
  const pid = Number(e._PID ?? 0);
  const key = `${boot}:${pid}`;
  let m: RegExpMatchArray | null;
  if ((m = msg.match(ACCEPTED))) {
    st.sessions.set(key, {
      key,
      boot,
      pid,
      user: m[2]!,
      ip: normIp(m[3]),
      port: Number(m[4]),
      method: methodOf(m[1]!),
      fingerprint: m[5] ?? null,
      start: t,
      end: null,
    });
    st.oldest = st.oldest === null ? t : Math.min(st.oldest, t);
  } else if ((m = msg.match(CLOSED)) || (m = msg.match(DISCONNECTED))) {
    const s = st.sessions.get(key);
    if (s && s.end === null) s.end = t;
  } else if ((m = msg.match(INVALID))) {
    st.pendingInvalid.set(key, st.fails.length);
    st.fails.push({
      t,
      ip: normIp(m[2]) ?? m[2]!,
      user: m[1]!.slice(0, 64),
      invalid: true,
    });
  } else if ((m = msg.match(FAILED))) {
    const invalid = !!m[2];
    if (invalid && st.pendingInvalid.has(key)) {
      // The "Invalid user" line already counted this attempt.
      st.pendingInvalid.delete(key);
      return;
    }
    st.fails.push({
      t,
      ip: normIp(m[4]) ?? m[4]!,
      user: m[3]!.slice(0, 64),
      invalid,
    });
  }
}

function prune(st: JournalState) {
  const cutoff = Date.now() - WINDOW - DAY;
  for (const [k, s] of st.sessions) if ((s.end ?? s.start) < cutoff) st.sessions.delete(k);
  if (st.fails.length && st.fails[0]!.t < cutoff) {
    const i = st.fails.findIndex((f) => f.t >= cutoff);
    st.fails = i < 0 ? [] : st.fails.slice(i);
    st.pendingInvalid.clear();
  }
  // Hard cap so a sustained attack can't grow memory without bound.
  if (st.fails.length > 250_000) st.fails = st.fails.slice(-250_000);
}

async function readJournal(st: JournalState) {
  const args = ["SYSLOG_IDENTIFIER=sshd", "SYSLOG_IDENTIFIER=sshd-session", "-o", "json", "--output-fields=MESSAGE,_PID,_BOOT_ID", "--no-pager", "-q"];
  if (st.cursor) args.push(`--after-cursor=${st.cursor}`);
  else args.push(`--since=@${Math.floor((Date.now() - WINDOW) / 1000)}`);
  const run = (grep: boolean) =>
    host("journalctl", grep ? [...args, `--grep=${GREP}`] : args, {
      timeoutMs: 45_000,
      maxBuffer: 256 * 1024 * 1024,
      okCodes: [1],
    });
  let stdout: string;
  try {
    ({ stdout } = await run(st.grep));
  } catch (e) {
    // journalctl built without pattern matching: read everything and filter here.
    if (!st.grep || !(e instanceof CommandError) || !/pattern|pcre|grep/i.test(`${e.message} ${e.stderr}`)) throw e;
    st.grep = false;
    ({ stdout } = await run(false));
  }
  let start = 0;
  for (;;) {
    const i = stdout.indexOf("\n", start);
    const line = i < 0 ? stdout.slice(start) : stdout.slice(start, i);
    if (line) ingest(st, line);
    if (i < 0) break;
    start = i + 1;
  }
  st.ok = true;
}

/** Bring the in-memory sign-in record up to date (cheap after the first read). */
export async function refreshSignIns(maxAgeMs = 20_000): Promise<JournalState> {
  const st = state();
  if (st.pending) {
    await st.pending;
    return st;
  }
  if (st.loadedAt && Date.now() - st.loadedAt < maxAgeMs) return st;
  st.pending = (async () => {
    try {
      await readJournal(st);
    } catch (e) {
      console.error("[gluon] reading sshd journal failed", (e as Error).message);
    } finally {
      st.loadedAt = Date.now();
      prune(st);
    }
  })();
  try {
    await st.pending;
  } finally {
    st.pending = undefined;
  }
  return st;
}

// ---------------------------------------------------------------- boots and wtmp

type Boot = { id: string; first: number; last: number };
let bootCache: { at: number; boots: Boot[] } | null = null;

async function boots(): Promise<Boot[]> {
  if (bootCache && Date.now() - bootCache.at < 5 * 60_000) return bootCache.boots;
  let list: Boot[] = [];
  try {
    const { stdout } = await host("journalctl", ["--list-boots", "-o", "json", "--no-pager", "-q"], { timeoutMs: 15_000 });
    const parsed = JSON.parse(stdout) as {
      boot_id?: string;
      first_entry?: number;
      last_entry?: number;
    }[];
    list = parsed
      .filter((b) => b.boot_id)
      .map((b) => ({
        id: b.boot_id!,
        first: Math.floor((b.first_entry ?? 0) / 1000),
        last: Math.floor((b.last_entry ?? 0) / 1000),
      }));
  } catch {
    list = [];
  }
  bootCache = { at: Date.now(), boots: list };
  return list;
}

interface WtmpRec {
  user: string;
  tty: string;
  ip: string | null;
  start: number;
  end: number | null;
}

const ISO = "(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d{4})";
const WTMP_LINE = new RegExp(`^(\\S+)\\s+(\\S+)\\s+(?:(\\S+)\\s+)?${ISO}\\s+-\\s+(still logged in|${ISO}|crash|down|gone.*)`);
const isoMs = (s: string) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

let wtmpCache: { at: number; recs: WtmpRec[] } | null = null;

/** `last`: console sign-ins (and SSH ones when the journal has none). */
async function wtmp(): Promise<WtmpRec[]> {
  if (wtmpCache && Date.now() - wtmpCache.at < 60_000) return wtmpCache.recs;
  const recs: WtmpRec[] = [];
  try {
    const { stdout } = await host("last", ["-i", "-w", "--time-format", "iso", "-n", "3000"], { timeoutMs: 10_000, okCodes: [1] });
    const cutoff = Date.now() - WINDOW;
    for (const line of stdout.split("\n")) {
      const m = line.match(WTMP_LINE);
      if (!m || m[1] === "reboot" || m[1] === "shutdown") continue;
      const start = isoMs(m[4]!);
      if (!Number.isFinite(start)) continue;
      const endRaw = m[5]!;
      const end = endRaw === "still logged in" ? null : /^\d/.test(endRaw) ? isoMs(endRaw) : start;
      if ((end ?? Date.now()) < cutoff) continue;
      const hostCol = m[3] && m[3] !== "0.0.0.0" && !/^:\d/.test(m[3]) ? m[3] : null;
      recs.push({
        user: m[1]!,
        tty: m[2]!,
        ip: normIp(hostCol),
        start,
        end: Number.isFinite(end as number) ? end : start,
      });
    }
  } catch {
    /* no last / wtmpdb */
  }
  wtmpCache = { at: Date.now(), recs };
  return recs;
}

// ---------------------------------------------------------------- history

interface FlatSession {
  user: string;
  ip: string | null;
  method: LoginMethod | null;
  fingerprint: string | null;
  start: number;
  end: number | null;
  console: boolean;
}

const MERGE_GAP = 5 * 60_000;

export async function signInHistory(): Promise<SignInHistory> {
  const [st, bootList, wt] = await Promise.all([refreshSignIns(), boots(), wtmp()]);
  const t = Date.now();
  const from = t - WINDOW;
  const thisBoot = currentBootId();
  const bootEnd = new Map(bootList.map((b) => [b.id, b.last]));

  const flat: FlatSession[] = [];
  for (const s of st.sessions.values()) {
    let end = s.end;
    if (end === null) {
      if (s.boot && s.boot !== thisBoot) end = bootEnd.get(s.boot) ?? s.start;
      else if (!pidAlive(s.pid)) end = s.start;
    }
    if ((end ?? t) < from) continue;
    flat.push({
      user: s.user,
      ip: s.ip,
      method: s.method,
      fingerprint: s.fingerprint,
      start: s.start,
      end,
      console: false,
    });
  }
  const journalHasSsh = flat.length > 0;
  for (const w of wt) {
    const console_ = /^tty\d/.test(w.tty) && !w.ip;
    if (!console_ && journalHasSsh) continue;
    flat.push({
      user: w.user,
      ip: w.ip,
      method: null,
      fingerprint: null,
      start: w.start,
      end: w.end,
      console: console_,
    });
  }

  // Lanes: one per person, overlapping sessions merged.
  const byUser = new Map<string, FlatSession[]>();
  for (const f of flat) (byUser.get(f.user) ?? byUser.set(f.user, []).get(f.user)!).push(f);
  const lanes: SignInLane[] = [];
  for (const [user, list] of byUser) {
    list.sort((a, b) => a.start - b.start);
    const spans: SignInSpan[] = [];
    let cur: (SignInSpan & { srcSet: Set<string | null> }) | null = null;
    for (const f of list) {
      const s = Math.max(f.start, from);
      const e = f.end ?? t;
      const away = zoneOf(f.ip) === "away";
      if (cur && s <= cur.end + MERGE_GAP) {
        cur.end = Math.max(cur.end, e);
        cur.open ||= f.end === null;
        cur.count++;
        cur.srcSet.add(f.console ? null : f.ip);
        cur.away ||= away && !f.console;
        cur.console ||= f.console;
      } else {
        if (cur) spans.push(finishSpan(cur));
        cur = {
          start: s,
          end: e,
          open: f.end === null,
          count: 1,
          sources: [],
          away: away && !f.console,
          console: f.console,
          srcSet: new Set([f.console ? null : f.ip]),
        };
      }
    }
    if (cur) spans.push(finishSpan(cur));
    lanes.push({
      user,
      sessions: list.length,
      awaySessions: list.filter((f) => !f.console && zoneOf(f.ip) === "away").length,
      open: list.filter((f) => f.end === null).length,
      lastAt: list.length ? Math.max(...list.map((f) => f.start)) : null,
      spans,
    });
  }
  lanes.sort((a, b) => b.open - a.open || (b.lastAt ?? 0) - (a.lastAt ?? 0));

  // Where sign-ins come from.
  const srcMap = new Map<string, SignInSource & { fp: string | null }>();
  for (const f of flat) {
    const k = `${f.user}|${f.console ? "console" : (f.ip ?? "")}|${f.method ?? ""}|${f.fingerprint ?? ""}`;
    const cur = srcMap.get(k);
    if (cur) {
      cur.count++;
      cur.firstAt = Math.min(cur.firstAt, f.start);
      cur.lastAt = Math.max(cur.lastAt, f.start);
      if (f.end === null) cur.open++;
    } else {
      srcMap.set(k, {
        user: f.user,
        ip: f.console ? null : f.ip,
        host: null,
        zone: f.console ? "local" : zoneOf(f.ip),
        method: f.method,
        keyLabel: null,
        fp: f.fingerprint,
        count: 1,
        firstAt: f.start,
        lastAt: f.start,
        open: f.end === null ? 1 : 0,
      });
    }
  }
  const sources = [...srcMap.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 24);

  const failures = summariseFailures(st.fails, from, t);
  const names = await reverseMany([...sources.map((x) => x.ip), ...failures.sources.slice(0, 8).map((x) => x.ip)]);
  const out: SignInSource[] = sources.map(({ fp, ...x }) => ({
    ...x,
    host: x.ip ? (names.get(x.ip) ?? null) : null,
    keyLabel: x.method === "key" ? keyLabel(x.user, fp) : null,
  }));
  failures.sources = failures.sources.map((x) => ({
    ...x,
    host: names.get(x.ip) ?? null,
  }));

  const oldestWtmp = wt.length ? Math.min(...wt.map((w) => w.start)) : null;
  const oldest = [st.oldest, oldestWtmp].filter((x): x is number => x !== null);
  return {
    from,
    to: t,
    lanes,
    sources: out,
    failures,
    boots: bootList.map((b) => b.first).filter((b) => b >= from),
    origin: { journal: st.ok, wtmp: wt.length > 0 },
    oldestRecord: oldest.length ? Math.min(...oldest) : null,
    checkedAt: t,
  };
}

function finishSpan(s: SignInSpan & { srcSet: Set<string | null> }): SignInSpan {
  const { srcSet, ...rest } = s;
  return { ...rest, sources: [...srcSet].slice(0, 4) };
}

function summariseFailures(fails: FailRec[], from: number, to: number): FailedAttempts {
  const binMs = 3_600_000;
  const start = Math.floor(from / binMs) * binMs;
  const n = Math.ceil((to - start) / binMs);
  const bins = new Array<number>(n).fill(0);
  const awayBins = new Array<number>(n).fill(0);
  const bySource = new Map<string, { count: number; lastAt: number; users: Map<string, number> }>();
  const byName = new Map<string, number>();
  let total = 0;
  let away = 0;
  let lastHour = 0;
  let lastHourAway = 0;
  const zoneCache = new Map<string, LoginZone>();
  for (const f of fails) {
    if (f.t < from) continue;
    const i = Math.min(n - 1, Math.floor((f.t - start) / binMs));
    let z = zoneCache.get(f.ip);
    if (!z) zoneCache.set(f.ip, (z = zoneOf(f.ip)));
    bins[i]!++;
    total++;
    if (z === "away") {
      awayBins[i]!++;
      away++;
    }
    if (to - f.t < binMs) {
      lastHour++;
      if (z === "away") lastHourAway++;
    }
    const src = bySource.get(f.ip) ?? bySource.set(f.ip, { count: 0, lastAt: 0, users: new Map() }).get(f.ip)!;
    src.count++;
    src.lastAt = Math.max(src.lastAt, f.t);
    src.users.set(f.user, (src.users.get(f.user) ?? 0) + 1);
    byName.set(f.user, (byName.get(f.user) ?? 0) + 1);
  }
  const accounts = passwdUsers();
  return {
    from: start,
    binMs,
    bins,
    awayBins,
    total,
    away,
    lastHour,
    lastHourAway,
    sources: [...bySource.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([ip, v]) => ({
        ip,
        host: null,
        zone: zoneCache.get(ip) ?? zoneOf(ip),
        count: v.count,
        lastAt: v.lastAt,
        users: [...v.users.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([u]) => u),
      })),
    names: [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count, exists: accounts.has(name) })),
  };
}

function pidAlive(pid: number): boolean {
  try {
    fs.accessSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- live sessions

const SESSION_ID = /^[A-Za-z0-9]{1,32}$/;

interface LogindSession {
  session: string;
  uid: number;
  user: string;
  leader: number;
  class: string;
  tty: string | null;
  seat: string | null;
}

async function listLogind(): Promise<LogindSession[]> {
  try {
    const { stdout } = await host("loginctl", ["list-sessions", "--json=short", "--no-pager"], { timeoutMs: 8000 });
    const parsed = JSON.parse(stdout) as Partial<LogindSession>[];
    return parsed
      .filter((s) => typeof s.session === "string" && SESSION_ID.test(s.session))
      .map((s) => ({
        session: s.session!,
        uid: Number(s.uid),
        user: String(s.user ?? ""),
        leader: Number(s.leader ?? 0),
        class: String(s.class ?? ""),
        tty: s.tty ?? null,
        seat: s.seat ?? null,
      }));
  } catch {
    // Older loginctl without JSON: SESSION UID USER SEAT TTY
    const { stdout } = await host("loginctl", ["list-sessions", "--no-legend", "--no-pager"], { timeoutMs: 8000 });
    return stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[0] && SESSION_ID.test(p[0]))
      .map((p) => ({
        session: p[0]!,
        uid: Number(p[1]),
        user: p[2] ?? "",
        leader: 0,
        class: "user",
        tty: null,
        seat: null,
      }));
  }
}

async function showSession(id: string): Promise<Record<string, string> | null> {
  try {
    const { stdout } = await host(
      "loginctl",
      [
        "show-session",
        id,
        "--no-pager",
        "-p",
        "Id",
        "-p",
        "Name",
        "-p",
        "User",
        "-p",
        "Leader",
        "-p",
        "Remote",
        "-p",
        "RemoteHost",
        "-p",
        "Service",
        "-p",
        "Type",
        "-p",
        "Class",
        "-p",
        "TTY",
        "-p",
        "Scope",
        "-p",
        "State",
      ],
      { timeoutMs: 6000 },
    );
    const rec: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) rec[line.slice(0, i)] = line.slice(i + 1);
    }
    return rec;
  } catch {
    return null; // ended between listing and asking
  }
}

/** `ss` as root: client address and port for each sshd process. */
async function sshConnections(): Promise<Map<number, { ip: string | null; port: number | null }>> {
  const out = new Map<number, { ip: string | null; port: number | null }>();
  try {
    const { stdout } = await host("ss", ["-tnpH", "state", "established"], {
      timeoutMs: 6000,
    });
    for (const line of stdout.split("\n")) {
      if (!/sshd/.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      // Recv-Q Send-Q Local Peer Process (state filter drops the State column)
      const peer = cols[3] ?? "";
      const m = peer.match(/^\[?(.+?)\]?:(\d+)$/);
      const info = { ip: normIp(m?.[1]), port: m ? Number(m[2]) : null };
      for (const p of line.matchAll(/pid=(\d+)/g)) out.set(Number(p[1]), info);
    }
  } catch {
    /* ss missing: fall back to logind's RemoteHost */
  }
  return out;
}

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "tcsh", "csh", "ash", "nu", "elvish"]);
const SSHD = /^(sshd|sshd-session|sshd-auth)$/;

const PROGRAM_LABEL: [RegExp, string][] = [
  [/^(vim?|nvim|nano|emacs|micro|helix|hx|ed|joe|mcedit)$/, "Editing a file"],
  [/^(h?top|btop|atop|glances|iotop|nethogs)$/, "Watching what the machine is doing"],
  [/^(tmux.*|screen)$/, "Inside a terminal multiplexer"],
  [/^(docker|docker-compose|lazydocker|ctop)$/, "Working with Docker"],
  [/^(apt|apt-get|dpkg|aptitude|unattended-upgr)$/, "Installing software"],
  [/^(sudo|su|doas)$/, "Running something as root"],
  [/^(less|more|most|journalctl|tail|dmesg)$/, "Reading logs or files"],
  [/^(rsync|scp|sftp-server|rclone|cp|mv|tar)$/, "Copying files"],
  [/^(ssh|mosh.*)$/, "Connected onward to another machine"],
  [/^(python\d*(\.\d+)?|node|ruby|perl|php|java)$/, "Running a script"],
  [/^(sleep)$/, "Waiting"],
  [/^(git)$/, "Using git"],
  [/^(make|cargo|go|npm|pnpm|yarn|gcc|cc)$/, "Building software"],
  [/^(mc|ranger|nnn|lf|yazi)$/, "Browsing files"],
  [/^(smartctl|fdisk|parted|lsblk|mount|umount|mkfs.*)$/, "Working with disks"],
  [/^(claude)$/, "Running Claude Code"],
];

function labelFor(program: string): string | null {
  for (const [re, label] of PROGRAM_LABEL) if (re.test(program)) return label;
  return null;
}

function scopeProcs(uid: number, scope: string): number[] {
  if (!/^session-[A-Za-z0-9]+\.scope$/.test(scope)) return [];
  const text =
    readHostFileOr(`/sys/fs/cgroup/user.slice/user-${uid}.slice/${scope}/cgroup.procs`, "") || readHostFileOr(`/sys/fs/cgroup/systemd/user.slice/user-${uid}.slice/${scope}/cgroup.procs`, "");
  return text
    .split("\n")
    .map(Number)
    .filter((n) => n > 0);
}

function idleFor(tty: string | null): number | null {
  if (!tty || !/^(pts\/\d+|tty\d+)$/.test(tty)) return null;
  try {
    const st = fs.statSync(hostPath(`/dev/${tty}`));
    return Math.max(0, Math.floor((Date.now() - st.atimeMs) / 1000));
  } catch {
    return null;
  }
}

async function readLive(): Promise<LiveSession[]> {
  const [list, conns, st] = await Promise.all([listLogind(), sshConnections(), refreshSignIns(60_000).catch(() => state())]);
  const boot = bootTimeMs();
  const bootId = currentBootId();
  const ownPid = process.pid;
  const users = passwdUsers();
  const candidates = list.filter((s) => s.class === "user" || s.class === "user-early" || s.class === "user-incomplete" || s.class === "");
  const details = await Promise.all(candidates.slice(0, 64).map((s) => showSession(s.session)));

  const out: LiveSession[] = [];
  candidates.slice(0, 64).forEach((s, i) => {
    const d = details[i];
    if (!d) return;
    if (d.State === "closing") return; // lingering after disconnect
    const uid = Number(d.User ?? s.uid);
    const user = d.Name || s.user;
    const leader = Number(d.Leader || s.leader) || 0;
    const pids = scopeProcs(uid, d.Scope ?? "");
    const stats = pids.map((p) => procStat(p, boot)).filter((x): x is ProcStat => !!x);
    const leaderStat = stats.find((x) => x.pid === leader) ?? (leader ? procStat(leader, boot) : null);

    // The sshd process that owns the connection is titled "sshd-session: luke@pts/0" / "luke@notty".
    let tty: string | null = d.TTY || s.tty || null;
    let sshUserPid: number | null = null;
    for (const p of stats) {
      if (!SSHD.test(p.comm)) continue;
      const title = procTitle(p.pid);
      const m = title.match(/@(pts\/\d+|notty)\b/);
      if (m) {
        sshUserPid = p.pid;
        if (m[1] !== "notty") tty = m[1]!;
      }
    }
    const programs = stats.filter((p) => !SSHD.test(p.comm));
    const remote = d.Remote === "yes";
    const service = d.Service || null;

    let kind: SessionKind;
    let running: LiveSession["running"] = null;
    if (!remote && /^tty\d+$/.test(tty ?? "")) kind = "console";
    else if (d.Type === "x11" || d.Type === "wayland" || d.Type === "mir") kind = "desktop";
    else if (tty) kind = "shell";
    else if (programs.some((p) => p.comm === "sftp-server" || p.comm === "internal-sftp")) kind = "files";
    else if (programs.length) kind = "command";
    else kind = "tunnel";

    if (kind === "shell" || kind === "console") {
      // The shell is the first non-sshd process started by the connection; its terminal's
      // foreground process group tells us what's running.
      const shell = programs.filter((p) => (sshUserPid ? p.ppid === sshUserPid : true)).sort((a, b) => a.startMs - b.startMs)[0] ?? programs[0];
      if (shell) {
        const fg = shell.tpgid > 0 && shell.tpgid !== shell.pid ? (programs.find((p) => p.pid === shell.tpgid) ?? procStat(shell.tpgid, boot)) : null;
        const prog = fg ?? shell;
        running = {
          program: prog.comm,
          label: fg ? labelFor(prog.comm) : "At the prompt",
        };
      }
    } else if (kind === "files") {
      running = { program: "sftp-server", label: null };
    } else if (kind === "command") {
      const pick = programs.filter((p) => !SHELLS.has(p.comm)).sort((a, b) => b.startMs - a.startMs)[0] ?? programs.sort((a, b) => b.startMs - a.startMs)[0]!;
      running = { program: pick.comm, label: labelFor(pick.comm) };
    }

    const conn = conns.get(leader) ?? (sshUserPid ? conns.get(sshUserPid) : undefined);
    const ip = conn?.ip ?? normIp(d.RemoteHost) ?? null;
    const rec = st.sessions.get(`${bootId}:${leader}`);
    const containsGluon = pids.includes(ownPid);
    let endBlocked: string | null = null;
    if (containsGluon) endBlocked = "Gluon itself runs in this session.";
    else if (!leader) endBlocked = "The session has no process Gluon can stop.";

    out.push({
      id: d.Id || s.session,
      user,
      kind,
      from: {
        ip: remote || ip ? ip : null,
        port: conn?.port ?? rec?.port ?? null,
        host: null,
        zone: remote || ip ? zoneOf(ip) : "local",
      },
      tty,
      service,
      startedAt: leaderStat?.startMs ?? rec?.start ?? Date.now(),
      idleSeconds: idleFor(tty),
      running,
      processes: programs.length,
      method: rec?.method ?? (kind === "console" ? "password" : null),
      keyLabel: rec?.method === "key" ? keyLabel(user, rec.fingerprint) : null,
      canEnd: !endBlocked && users.has(user),
      endBlocked: endBlocked ?? (users.has(user) ? null : "Gluon doesn't recognise this account."),
    });
  });

  const names = await reverseMany(out.map((x) => x.from.ip));
  for (const x of out) x.from.host = x.from.ip ? (names.get(x.from.ip) ?? null) : null;
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ---------------------------------------------------------------- posture

function yes(v: string | undefined): boolean | null {
  return v === undefined ? null : v === "yes";
}

async function readPosture(): Promise<Omit<SshPosture, "seenFromOutside" | "blocker" | "running" | "unit">> {
  const c = g.__gluonPosture;
  if (c && Date.now() - c.at < 5 * 60_000) return c.posture;
  let posture: Omit<SshPosture, "seenFromOutside" | "blocker" | "running" | "unit">;
  try {
    const { stdout } = await host("sshd", ["-T"], { timeoutMs: 8000 });
    const kv = new Map<string, string[]>();
    for (const line of stdout.split("\n")) {
      const i = line.indexOf(" ");
      if (i <= 0) continue;
      const k = line.slice(0, i).toLowerCase();
      (kv.get(k) ?? kv.set(k, []).get(k)!).push(line.slice(i + 1).trim());
    }
    const one = (k: string) => kv.get(k)?.[0];
    const root = one("permitrootlogin");
    const pw = yes(one("passwordauthentication"));
    // With UsePAM, keyboard-interactive is a password prompt too.
    const kbd = yes(one("kbdinteractiveauthentication") ?? one("challengeresponseauthentication"));
    const methods = one("authenticationmethods");
    const keyOnlyByMethods = !!methods && methods !== "any" && !/password|keyboard-interactive/.test(methods);
    posture = {
      installed: true,
      ports: [...new Set((kv.get("port") ?? []).map(Number).filter((n) => n > 0))],
      password: keyOnlyByMethods ? false : pw === null && kbd === null ? null : !!pw || (!!kbd && one("usepam") === "yes"),
      emptyPasswords: yes(one("permitemptypasswords")),
      keys: yes(one("pubkeyauthentication")),
      root: root === "yes" ? "yes" : root === "prohibit-password" || root === "without-password" ? "keys-only" : root === "forced-commands-only" ? "commands-only" : root === "no" ? "no" : null,
      maxAuthTries: Number(one("maxauthtries")) || null,
      allowUsers: (kv.get("allowusers") ?? []).flatMap((x) => x.split(/\s+/)).filter(Boolean),
      error: null,
    };
  } catch (e) {
    const missing = e instanceof CommandError && (e.code === 127 || /not found|No such file/i.test(e.message));
    posture = {
      installed: !missing,
      ports: [],
      password: null,
      emptyPasswords: null,
      keys: null,
      root: null,
      maxAuthTries: null,
      allowUsers: [],
      error: missing ? null : "Gluon couldn't read the SSH settings.",
    };
  }
  g.__gluonPosture = { at: Date.now(), posture };
  return posture;
}

async function sshPosture(): Promise<SshPosture> {
  const [base, services, st] = await Promise.all([readPosture(), listServices({ maxAgeMs: 60_000 }).catch(() => []), refreshSignIns(60_000).catch(() => state())]);
  const unit = services.find((s) => /^(ssh|sshd)\.service$/.test(s.unit) && s.load !== "not-found") ?? null;
  const blockerUnit = services.find((s) => /^(fail2ban|crowdsec|sshguard)\.service$/.test(s.unit) && s.load !== "not-found");
  const from = Date.now() - WINDOW;
  const seen = [...st.sessions.values()].some((s) => s.start >= from && zoneOf(s.ip) === "away") || failuresSince(from).some((f) => zoneOf(f.ip) === "away");
  return {
    ...base,
    running: unit ? unit.active === "active" : base.installed ? null : false,
    unit: unit?.unit ?? null,
    blocker: blockerUnit ? { name: blockerUnit.name, running: blockerUnit.active === "active" } : null,
    seenFromOutside: seen,
  };
}

// ---------------------------------------------------------------- public API

/** Live sessions + SSH posture; shared by the page, the widget and the checks (cached 4 s). */
export async function liveLogins(opts: { maxAgeMs?: number } = {}): Promise<LiveLogins> {
  const c = g.__gluonLiveLogins;
  if (c && Date.now() - c.at < (opts.maxAgeMs ?? 4000)) return c.data;
  if (c?.pending) return c.pending;
  const pending = (async () => {
    const [sessions, posture] = await Promise.all([readLive(), sshPosture()]);
    const data: LiveLogins = { sessions, posture, checkedAt: Date.now() };
    g.__gluonLiveLogins = { at: Date.now(), data };
    return data;
  })();
  g.__gluonLiveLogins = {
    at: c?.at ?? 0,
    data: c?.data ?? { sessions: [], posture: {} as SshPosture, checkedAt: 0 },
    pending,
  };
  try {
    return await pending;
  } catch (e) {
    if (g.__gluonLiveLogins?.pending === pending) g.__gluonLiveLogins.pending = undefined;
    throw e;
  }
}

export function invalidateLiveLogins() {
  if (g.__gluonLiveLogins) g.__gluonLiveLogins.at = 0;
}

/**
 * End a session: logind stops every process in it, which drops the SSH connection.
 * Refuses sessions Gluon can't identify, and any session Gluon itself runs in.
 */
export async function endSession(id: string): Promise<LiveSession> {
  if (!SESSION_ID.test(id)) throw new AppError("invalid_session", "That isn't a valid session.", 400);
  const live = await liveLogins({ maxAgeMs: 0 });
  const s = live.sessions.find((x) => x.id === id);
  if (!s) throw notFound("That session");
  if (!s.canEnd) throw new AppError("session_protected", s.endBlocked ?? "Gluon won't end this session.", 409);
  try {
    await host("loginctl", ["terminate-session", id], { timeoutMs: 10_000 });
  } catch (e) {
    throw new AppError("end_failed", "The session couldn't be ended. It may have just closed on its own.", 500, { error: (e as Error).message });
  }
  invalidateLiveLogins();
  return s;
}

/** Recent sign-ins for the checks: sessions started since `since`. */
export function signInsSince(since: number): {
  user: string;
  ip: string | null;
  method: LoginMethod;
  fingerprint: string | null;
  start: number;
  open: boolean;
}[] {
  const st = state();
  const thisBoot = currentBootId();
  const out = [];
  for (const s of st.sessions.values()) {
    if (s.start < since) continue;
    out.push({
      user: s.user,
      ip: s.ip,
      method: s.method,
      fingerprint: s.fingerprint,
      start: s.start,
      open: s.end === null && s.boot === thisBoot && pidAlive(s.pid),
    });
  }
  return out;
}

export function failuresSince(since: number): FailRec[] {
  const fails = state().fails;
  let i = fails.length;
  while (i > 0 && fails[i - 1]!.t >= since) i--;
  return fails.slice(i);
}

export { reverse as reverseLookup, keyLabel as keyLabelFor };
