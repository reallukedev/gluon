import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { all, now, one, run } from "../db";
import { hmac, id as newId, sha256 } from "../crypto";
import { AppError, badRequest, conflict, notFound } from "../errors";

export type Role = "admin" | "member";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  recovery_codes: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  password_changed_at: number | null;
  disabled: number;
  must_change_password?: number;
}

/** What the rest of the app (and the client) sees. Never includes secrets. */
export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mfa: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
  mustChangePassword: boolean;
}

export const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  mfa: !!r.totp_enabled,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  disabled: !!r.disabled,
  mustChangePassword: !!r.must_change_password,
});

// OWASP 2024 argon2id baseline (19 MiB, t=2, p=1).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 as const };

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

export function validatePassword(pw: string, _username?: string) {
  if (pw.length < 1) throw badRequest("Enter a password.", { field: "password" });
  if (pw.length > 256) throw badRequest("That password is too long.", { field: "password" });
}

/**
 * argon2id costs ~19 MiB and tens of milliseconds per call. A flood of sign-in attempts must not be
 * able to exhaust memory, so at most a few run at once and a bounded queue waits behind them.
 */
const ARGON_CONCURRENCY = 4;
const ARGON_QUEUE = 64;
let argonActive = 0;
const argonWaiting: Array<() => void> = [];
async function withArgon<T>(fn: () => Promise<T>): Promise<T> {
  if (argonActive >= ARGON_CONCURRENCY) {
    if (argonWaiting.length >= ARGON_QUEUE) throw new AppError("busy", "The server is busy. Try again in a moment.", 503);
    await new Promise<void>((r) => argonWaiting.push(r));
  }
  argonActive++;
  try {
    return await fn();
  } finally {
    argonActive--;
    argonWaiting.shift()?.();
  }
}

export const hashPassword = (pw: string) => withArgon(() => hash(pw, ARGON));

/** A fixed dummy hash so unknown usernames take the same time as wrong passwords. */
let dummyHash: Promise<string> | null = null;
export async function verifyPassword(row: UserRow | undefined, pw: string): Promise<boolean> {
  if (!row) {
    dummyHash ??= hashPassword("gluon-timing-equaliser");
    const h = await dummyHash;
    await withArgon(() => verify(h, pw)).catch(() => false);
    return false;
  }
  return withArgon(() => verify(row.password_hash, pw)).catch((e) => {
    if (e instanceof AppError) throw e;
    return false;
  });
}

export const userCount = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
export const adminCount = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")?.n ?? 0;

export const findByUsername = (username: string) =>
  one<UserRow>("SELECT * FROM users WHERE username = ? COLLATE NOCASE", username.trim());
export const findById = (id: string) => one<UserRow>("SELECT * FROM users WHERE id = ?", id);

export function listUsers(): User[] {
  return all<UserRow>("SELECT * FROM users ORDER BY role = 'admin' DESC, display_name COLLATE NOCASE").map(toUser);
}

export async function createUser(input: { username: string; displayName: string; role: Role; password: string }): Promise<User> {
  const username = input.username.trim();
  if (!USERNAME_RE.test(username)) {
    throw badRequest("Usernames use letters, numbers, dots, dashes or underscores (2–32 characters).", { field: "username" });
  }
  if (findByUsername(username)) throw conflict("That username is taken.");
  validatePassword(input.password, username);
  const t = now();
  const id = newId();
  run(
    `INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    username,
    input.displayName.trim() || username,
    input.role,
    await hashPassword(input.password),
    t,
    t,
    t,
  );
  return toUser(findById(id)!);
}

export async function setPassword(userId: string, password: string) {
  const row = findById(userId);
  if (!row) throw notFound("That person");
  validatePassword(password, row.username);
  const t = now();
  run("UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?", await hashPassword(password), t, t, userId);
}

export function updateProfile(userId: string, patch: { displayName?: string; role?: Role; disabled?: boolean }) {
  const row = findById(userId);
  if (!row) throw notFound("That person");
  if ((patch.role === "member" || patch.disabled) && row.role === "admin" && adminCount() <= 1) {
    throw new AppError("last_admin", "There has to be at least one admin. Make someone else an admin first.", 409);
  }
  run(
    "UPDATE users SET display_name = COALESCE(?, display_name), role = COALESCE(?, role), disabled = COALESCE(?, disabled), updated_at = ? WHERE id = ?",
    patch.displayName?.trim() || null,
    patch.role ?? null,
    patch.disabled === undefined ? null : patch.disabled ? 1 : 0,
    now(),
    userId,
  );
  if (patch.disabled) run("DELETE FROM sessions WHERE user_id = ?", userId);
}

export function deleteUser(userId: string) {
  const row = findById(userId);
  if (!row) throw notFound("That person");
  if (row.role === "admin" && adminCount() <= 1) {
    throw new AppError("last_admin", "You can't remove the last admin.", 409);
  }
  run("DELETE FROM users WHERE id = ?", userId);
}

/**
 * Recovery codes are stored as a keyed hash (HMAC with the server's secret key), so a copy of the
 * database alone can't be brute-forced back into codes. Older codes (plain SHA-256) still verify.
 */
const normRecovery = (code: string) => code.replace(/[^a-z0-9]/gi, "").toLowerCase();
export function recoveryHash(code: string) {
  return `h1:${hmac("recovery", normRecovery(code))}`;
}
export function recoveryHashes(code: string): string[] {
  return [recoveryHash(code), sha256(normRecovery(code))];
}
