import "server-only";
import { db, now, one, run, all } from "../db";
import { sha256, token } from "../crypto";
import { raise, resolve } from "../findings";
import { audit } from "../audit";
import type { Zone } from "../net-zone";
import type { UserRow } from "./users";

/**
 * Known devices. Each browser gets a long-lived random cookie (separate from the session, so it
 * survives signing out). The first full sign-in of an account from a device is "new"; an admin's
 * new device away from home is recorded in Activity and raised as a finding (which notifies).
 */

export const DEVICE_COOKIE = "gluon_device";
export const DEVICE_COOKIE_SECURE = "__Host-gluon_device";
export const DEVICE_MAX_AGE_S = 400 * 86_400;

let ready = false;
/** Same statements as migration 10 (idempotent), so a running server doesn't need a restart. */
function ensureTables() {
  if (ready) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS known_devices (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      first_ip TEXT,
      first_zone TEXT,
      PRIMARY KEY (user_id, device_hash)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS session_devices (
      session_hash TEXT PRIMARY KEY REFERENCES sessions(id_hash) ON DELETE CASCADE ON UPDATE CASCADE,
      device_hash TEXT NOT NULL,
      new_device INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
  `);
  ready = true;
}

export const newDeviceToken = () => token(24);
export const deviceHash = (raw: string) => sha256(`device:${raw}`);

/** Record a full sign-in from this device. Returns true the first time this account uses it. */
export function rememberDevice(userId: string, hash: string, where: { ip: string; zone: Zone }): boolean {
  ensureTables();
  const t = now();
  const existing = one<{ first_seen: number }>("SELECT first_seen FROM known_devices WHERE user_id = ? AND device_hash = ?", userId, hash);
  if (existing) {
    run("UPDATE known_devices SET last_seen = ? WHERE user_id = ? AND device_hash = ?", t, userId, hash);
    return false;
  }
  const hadAny = !!one("SELECT 1 FROM known_devices WHERE user_id = ? LIMIT 1", userId);
  run(
    "INSERT INTO known_devices (user_id, device_hash, first_seen, last_seen, first_ip, first_zone) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    hash,
    t,
    t,
    where.ip,
    where.zone,
  );
  // The very first device an account ever uses (setup, accepting an invite, or the first sign-in
  // after this feature arrived) isn't news.
  return hadAny;
}

export function linkSessionDevice(sessionHash: string, hash: string, isNew: boolean) {
  ensureTables();
  run(
    "INSERT INTO session_devices (session_hash, device_hash, new_device) VALUES (?, ?, ?) ON CONFLICT(session_hash) DO UPDATE SET device_hash = excluded.device_hash, new_device = excluded.new_device",
    sessionHash,
    hash,
    isNew ? 1 : 0,
  );
}

export function sessionDevices(sessionHashes: string[]): Map<string, { deviceHash: string; newDevice: boolean }> {
  ensureTables();
  const out = new Map<string, { deviceHash: string; newDevice: boolean }>();
  if (!sessionHashes.length) return out;
  const rows = all<{ session_hash: string; device_hash: string; new_device: number }>(
    `SELECT session_hash, device_hash, new_device FROM session_devices WHERE session_hash IN (${sessionHashes.map(() => "?").join(",")})`,
    ...sessionHashes,
  );
  for (const r of rows) out.set(r.session_hash, { deviceHash: r.device_hash, newDevice: !!r.new_device });
  return out;
}

/** "It was me": stop flagging this session's device. */
export function acknowledgeDevice(userId: string, sessionHash: string) {
  ensureTables();
  run("UPDATE session_devices SET new_device = 0 WHERE session_hash = ?", sessionHash);
  resolve(newDeviceFindingId(userId, sessionHash), "Confirmed by the account owner");
}

export const newDeviceFindingId = (userId: string, sessionHash: string) => `signin.new_device:${userId}:${sessionHash.slice(0, 12)}`;

function describeAgent(ua: string | null): string {
  if (!ua) return "an unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Called after a full sign-in (password, plus second step when on). */
export function noteSignIn(row: Pick<UserRow, "id" | "username" | "display_name" | "role">, sessionHash: string, deviceHashValue: string, where: { ip: string; zone: Zone; userAgent: string | null }) {
  const isNew = rememberDevice(row.id, deviceHashValue, where);
  const flag = isNew && where.zone === "away";
  linkSessionDevice(sessionHash, deviceHashValue, flag);
  if (!flag) return;
  const what = describeAgent(where.userAgent);
  audit(
    { id: row.id, username: row.username },
    { action: "auth.new_device", summary: `Signed in from a new device outside home (${what})`, target: row.id, detail: { ip: where.ip, userAgent: where.userAgent } },
    where,
  );
  if (row.role !== "admin") return;
  raise({
    id: newDeviceFindingId(row.id, sessionHash),
    kind: "signin.new_device",
    severity: "attention",
    subject: row.id,
    title: `${row.display_name || row.username} signed in as an admin from a new device outside home`,
    cause: `${what} at ${where.ip}. If this wasn't them, sign that device out and change the password.`,
    detail: { userId: row.id, ip: where.ip, userAgent: where.userAgent },
    remedy: { action: "", label: "Review devices", href: "/settings/security" },
  });
}

/** Clear new-device findings whose session has ended, and any older than a week. */
export function pruneDeviceFindings() {
  ensureTables();
  const open = all<{ id: string; first_seen: number }>("SELECT id, first_seen FROM findings WHERE kind = 'signin.new_device' AND resolved_at IS NULL");
  if (!open.length) return;
  const live = new Set(
    all<{ id_hash: string; user_id: string }>("SELECT id_hash, user_id FROM sessions WHERE expires_at > ?", now()).map((s) => newDeviceFindingId(s.user_id, s.id_hash)),
  );
  for (const f of open) {
    if (!live.has(f.id)) resolve(f.id, "That device is signed out");
    else if (now() - f.first_seen > 7 * 86_400_000) resolve(f.id);
  }
}
