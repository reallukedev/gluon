import "server-only";
import { all, now, one, run } from "../db";
import { AppError } from "../errors";
import { resolve } from "../findings";
import type { Zone } from "../net-zone";

/**
 * Sign-in throttling, stored in SQLite so it survives restarts.
 *
 * Every secret-checking endpoint (password, second step, re-auth, password change, setup code) calls
 * `guard()` first and `recordAttempt()` after. Failures are counted per subject (an account, for one
 * purpose) *and per zone*, so strangers hammering an account from the internet slow down the
 * internet: never the person signing in at home. Per IP address there is a hard cap as well.
 *
 *   away, per account: 5 free failures in 24 h, then 1 min, 2, 4 … up to 1 h between tries
 *   home, per account: 5 free failures in 15 min, then 30 s, 1 min … up to 15 min
 *   per IP:            30 failures in 15 min, or (away) 100 in 24 h, blocks that address for the window
 */
const HOME = { window: 15 * 60_000, free: 5, base: 30_000, max: 15 * 60_000 };
const AWAY = { window: 24 * 3600_000, free: 5, base: 60_000, max: 60 * 60_000 };
const IP_SHORT = { window: 15 * 60_000, max: 30 };
const IP_LONG = { window: 24 * 3600_000, max: 100 };

const acctKey = (subject: string, zone: Zone) => `acct:${zone}:${subject.toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

/** Seconds to wait before `subject` may try again from this address, or 0. */
export function retryAfter(subject: string, ip: string, zone: Zone = "home"): number {
  const t = now();
  const p = zone === "away" ? AWAY : HOME;
  const acct = one<{ n: number; last: number | null }>(
    "SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
    acctKey(subject, zone),
    t - p.window,
  );
  let wait = 0;
  if (acct && acct.n >= p.free && acct.last) {
    const backoff = Math.min(p.max, p.base * 2 ** (acct.n - p.free));
    wait = Math.max(wait, acct.last + backoff - t);
  }
  const short = one<{ n: number; first: number | null }>(
    "SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
    ipKey(ip),
    t - IP_SHORT.window,
  );
  if (short && short.n >= IP_SHORT.max && short.first) wait = Math.max(wait, short.first + IP_SHORT.window - t);
  if (zone === "away") {
    const long = one<{ n: number; first: number | null }>(
      "SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
      ipKey(ip),
      t - IP_LONG.window,
    );
    if (long && long.n >= IP_LONG.max && long.first) wait = Math.max(wait, long.first + IP_LONG.window - t);
  }
  return Math.max(0, Math.ceil(wait / 1000));
}

export function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const m = Math.ceil(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** Throw a friendly 429 if this subject/address has to wait. */
export function guard(subject: string, ip: string, zone: Zone, what = "attempts") {
  const wait = retryAfter(subject, ip, zone);
  if (wait > 0) {
    throw new AppError("rate_limited", `Too many ${what}. Try again in ${waitText(wait)}.`, 429, { retryAfter: wait });
  }
}

/**
 * Record the outcome. A success clears the subject's failures in both zones (the secret is proven).
 * Returns the subject's failure count in this zone's window after a failure, and whether this failure
 * is the one that started the slowdown (so the caller can tell an admin once).
 */
export function recordAttempt(subject: string, ip: string, ok: boolean, zone: Zone = "home"): { failures: number; startedThrottle: boolean } {
  const t = now();
  if (ok) {
    run("DELETE FROM login_attempts WHERE key IN (?, ?)", acctKey(subject, "home"), acctKey(subject, "away"));
    return { failures: 0, startedThrottle: false };
  }
  run("INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0), (?, ?, 0)", acctKey(subject, zone), t, ipKey(ip), t);
  const p = zone === "away" ? AWAY : HOME;
  const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ? AND ok = 0", acctKey(subject, zone), t - p.window)?.n ?? 0;
  return { failures: n, startedThrottle: n === p.free };
}

// ---------------------------------------------------------------- bursts (in memory)

type G = typeof globalThis & { __gluonBursts?: Map<string, number[]> };
const g = globalThis as G;
const bursts = () => (g.__gluonBursts ??= new Map<string, number[]>());

/**
 * Cheap flood control for public endpoints (sign-in, setup, invites): at most `limit` requests per
 * `windowMs` per key. In memory on purpose: it only has to blunt floods, the durable limits above
 * do the real work. Returns seconds to wait, or 0 (and counts this request).
 */
export function burst(key: string, limit: number, windowMs: number): number {
  const t = Date.now();
  const m = bursts();
  const hits = (m.get(key) ?? []).filter((x: number) => x > t - windowMs);
  if (hits.length >= limit) {
    m.set(key, hits);
    return Math.max(1, Math.ceil((hits[0]! + windowMs - t) / 1000));
  }
  hits.push(t);
  m.set(key, hits);
  if (m.size > 5000) {
    for (const [k, v] of m) if (!v.length || v[v.length - 1]! < t - 10 * 60_000) m.delete(k);
  }
  return 0;
}

export function pruneAttempts() {
  run("DELETE FROM login_attempts WHERE at < ?", now() - 48 * 3600_000);
  // Throttle notices clear once their account has been quiet for a day.
  const open = all<{ id: string; last_seen: number }>("SELECT id, last_seen FROM findings WHERE kind = 'signin.throttled' AND resolved_at IS NULL");
  for (const f of open) if (now() - f.last_seen > AWAY.window) resolve(f.id, "No more failed sign-ins");
}

/** Forget an account's sign-in failures (after an admin resets its password). */
export function clearThrottle(username: string) {
  const u = username.toLowerCase();
  run("DELETE FROM login_attempts WHERE key IN (?, ?, ?)", `acct:home:login:${u}`, `acct:away:login:${u}`, `user:${u}`);
}
