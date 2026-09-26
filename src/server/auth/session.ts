import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { all, now, one, run } from "../db";
import { sha256, token } from "../crypto";
import { clientInfo, isHttpsRequest, type Zone } from "../net-zone";
import { getSetting } from "../settings";
import { findById, toUser, type User } from "./users";
import { DEVICE_COOKIE, DEVICE_COOKIE_SECURE, DEVICE_MAX_AGE_S, deviceHash, newDeviceToken, pruneDeviceFindings, sessionDevices } from "./devices";

/**
 * Session cookies. Over HTTPS (the public address, behind Caddy) the cookie is `__Host-` prefixed:
 * the browser then insists on Secure, Path=/ and no Domain, so a sibling subdomain can't plant or
 * overwrite it. Plain-HTTP LAN addresses keep the old name (a Secure cookie can't be set there). The
 * two never meet: a cookie belongs to the address it was set on.
 */
export const SESSION_COOKIE = "gluon_session";
export const SESSION_COOKIE_SECURE = "__Host-gluon_session";
const RECENT_AUTH_MS = 10 * 60_000;
const TOUCH_EVERY_MS = 60_000;
const PENDING_MS = 10 * 60_000;
/** Enrolling a second step from the invite flow takes longer than typing a code. */
const ENROL_PENDING_MS = 20 * 60_000;

/** What a session is still waiting for: nothing, the second-step code, or setting up two-step. */
export type Pending = "none" | "code" | "enrol";
const PENDING_DB: Record<Pending, number> = { none: 0, code: 1, enrol: 2 };
const pendingOf = (n: number): Pending => (n === 2 ? "enrol" : n === 1 ? "code" : "none");

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  recent_auth_at: number;
  mfa_pending: number;
  ip: string | null;
  user_agent: string | null;
  zone: string | null;
}

export interface Session {
  idHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  recentAuthAt: number;
  /** True while the session is not yet a full sign-in (see `pending`). */
  mfaPending: boolean;
  pending: Pending;
  ip: string | null;
  userAgent: string | null;
  zone: Zone;
}

const toSession = (r: SessionRow): Session => ({
  idHash: r.id_hash,
  userId: r.user_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  recentAuthAt: r.recent_auth_at,
  mfaPending: !!r.mfa_pending,
  pending: pendingOf(r.mfa_pending),
  ip: r.ip,
  userAgent: r.user_agent,
  zone: (r.zone as Zone) ?? "home",
});

/** Inactivity before signing in again. Sessions used from outside home get the shorter of the two. */
export function lifetimeMs(zone: Zone): number {
  const home = getSetting("sessionDays");
  const days = zone === "away" ? Math.min(home, getSetting("awaySessionDays")) : home;
  return days * 86_400_000;
}

async function requestInfo() {
  const h = await headers();
  return { h, https: isHttpsRequest(h), ...clientInfo(h) };
}

const cookieName = (https: boolean) => (https ? SESSION_COOKIE_SECURE : SESSION_COOKIE);

async function readRawCookie(): Promise<string | undefined> {
  const [jar, { https }] = await Promise.all([cookies(), requestInfo()]);
  return jar.get(cookieName(https))?.value;
}

async function writeCookie(raw: string, expires: number) {
  const [jar, { https }] = await Promise.all([cookies(), requestInfo()]);
  jar.set(cookieName(https), raw, { httpOnly: true, sameSite: "lax", secure: https, path: "/", expires: new Date(expires) });
}

/** The browser's device id (hashed), creating the long-lived device cookie if it has none. */
export async function currentDevice(): Promise<string> {
  const [jar, { https }] = await Promise.all([cookies(), requestInfo()]);
  const name = https ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE;
  let raw = jar.get(name)?.value;
  if (!raw || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    raw = newDeviceToken();
  }
  // Refresh the expiry on every sign-in so a device in regular use stays known.
  jar.set(name, raw, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: DEVICE_MAX_AGE_S });
  return deviceHash(raw);
}

/**
 * Start a session for this browser. Whatever session the browser had before is ended first, so an
 * identifier planted before sign-in can never become a signed-in one. Returns the new id hash.
 */
export async function createSession(userId: string, opts: { pending: Pending } | { mfaPending: boolean }): Promise<string> {
  const pending: Pending = "pending" in opts ? opts.pending : opts.mfaPending ? "code" : "none";
  const { h, ip, zone } = await requestInfo();
  const previous = await readRawCookie();
  if (previous && previous.length <= 100) run("DELETE FROM sessions WHERE id_hash = ?", sha256(previous));
  const raw = token(32);
  const idHash = sha256(raw);
  const t = now();
  const expires = pending === "enrol" ? t + ENROL_PENDING_MS : pending === "code" ? t + PENDING_MS : t + lifetimeMs(zone);
  run(
    `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, recent_auth_at, mfa_pending, ip, user_agent, zone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    idHash,
    userId,
    t,
    expires,
    t,
    t,
    PENDING_DB[pending],
    ip,
    (h.get("user-agent") ?? "").slice(0, 300),
    zone,
  );
  await writeCookie(raw, expires);
  return idHash;
}

/**
 * Upgrade a pending session to a full one after the second step. The session gets a new identifier
 * (the pre-second-step one stops working). Returns the new id hash.
 */
export async function completeMfa(idHash: string): Promise<string> {
  const { zone, ip } = await requestInfo();
  const t = now();
  const expires = t + lifetimeMs(zone);
  const raw = token(32);
  const next = sha256(raw);
  run(
    "UPDATE sessions SET id_hash = ?, mfa_pending = 0, expires_at = ?, recent_auth_at = ?, last_seen_at = ?, ip = ?, zone = ? WHERE id_hash = ?",
    next,
    expires,
    t,
    t,
    ip,
    zone,
    idHash,
  );
  await writeCookie(raw, expires);
  return next;
}

export function markRecentAuth(idHash: string) {
  run("UPDATE sessions SET recent_auth_at = ? WHERE id_hash = ?", now(), idHash);
}

export const hasRecentAuth = (s: Session) => now() - s.recentAuthAt < RECENT_AUTH_MS;

async function readSession(): Promise<{ session: Session; user: User } | null> {
  const raw = await readRawCookie();
  if (!raw || raw.length > 100) return null;
  const idHash = sha256(raw);
  const row = one<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", idHash);
  if (!row) return null;
  const t = now();
  if (row.expires_at < t) {
    run("DELETE FROM sessions WHERE id_hash = ?", idHash);
    return null;
  }
  const userRow = findById(row.user_id);
  if (!userRow || userRow.disabled) return null;
  const session = toSession(row);
  // Refresh the zone from the current request so "away" policies follow the device.
  const { ip, zone } = await requestInfo();
  session.zone = zone;
  session.ip = ip;
  if (t - row.last_seen_at > TOUCH_EVERY_MS && !row.mfa_pending) {
    // Rolling expiry: active sessions stay signed in (for less long while away).
    run("UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ?, zone = ? WHERE id_hash = ?", t, t + lifetimeMs(zone), ip, zone, idHash);
  }
  return { session, user: toUser(userRow) };
}

/** The signed-in user for this request (deduplicated per request). Excludes pending sessions. */
export const currentAuth = cache(async () => {
  const s = await readSession();
  if (!s || s.session.mfaPending) return null;
  return s;
});

/** Includes pending sessions (used by the second-step and set-up-two-step endpoints). */
export const pendingAuth = cache(readSession);

export async function requireUser(): Promise<{ session: Session; user: User }> {
  const a = await currentAuth();
  if (!a) redirect("/login");
  return a;
}

export async function requireAdmin(): Promise<{ session: Session; user: User }> {
  const a = await requireUser();
  if (a.user.role !== "admin") redirect("/");
  return a;
}

export async function destroyCurrentSession() {
  const [jar, { https }] = await Promise.all([cookies(), requestInfo()]);
  const name = cookieName(https);
  const raw = jar.get(name)?.value;
  if (raw && raw.length <= 100) run("DELETE FROM sessions WHERE id_hash = ?", sha256(raw));
  jar.delete(name);
}

export function listSessions(userId: string): Session[] {
  return all<SessionRow>("SELECT * FROM sessions WHERE user_id = ? AND mfa_pending = 0 AND expires_at > ? ORDER BY last_seen_at DESC", userId, now()).map(
    toSession,
  );
}

/** Sessions with their device flags, for "Where you're signed in". */
export function listSessionsWithDevices(userId: string) {
  const list = listSessions(userId);
  const devices = sessionDevices(list.map((s) => s.idHash));
  return list.map((s) => ({ ...s, deviceHash: devices.get(s.idHash)?.deviceHash ?? null, newDevice: devices.get(s.idHash)?.newDevice ?? false }));
}

export function revokeSession(userId: string, idHash: string) {
  run("DELETE FROM sessions WHERE user_id = ? AND id_hash = ?", userId, idHash);
}

export function revokeOtherSessions(userId: string, keepIdHash: string): number {
  return run("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", userId, keepIdHash).changes;
}

export function pruneSessions() {
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  try {
    pruneDeviceFindings();
  } catch (e) {
    console.error("[gluon] device findings prune failed", e);
  }
}
