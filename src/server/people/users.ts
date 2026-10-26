import "server-only";
import { all, now, run, tx } from "../db";
import { AppError, badRequest, notFound } from "../errors";
import { publicBaseUrl, getSetting } from "../settings";
import { findById, setPassword, updateProfile, deleteUser, type Role, type User, type UserRow } from "../auth/users";
import { createInvite, listInvites, revokeInvite } from "../auth/invites";
import { listSessions, revokeSession } from "../auth/session";
import { disableTotp } from "../auth/totp";
import { clearThrottle } from "../auth/ratelimit";
import type { CreatedInvite, InviteView, PersonSession, PersonView } from "@/lib/people-types";

/** Does a column exist? (Lets code written for a pending migration degrade instead of failing.) */
const colCache = new Map<string, boolean>();
export function hasColumn(table: string, column: string): boolean {
  const key = `${table}.${column}`;
  const hit = colCache.get(key);
  if (hit !== undefined) return hit;
  const ok = all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  if (ok) colCache.set(key, ok); // only cache "yes": a migration may add it later
  return ok;
}

type Row = UserRow & { must_change_password?: number };

export function listPeople(viewer: User): PersonView[] {
  const t = now();
  const users = all<Row>("SELECT * FROM users ORDER BY role = 'admin' DESC, display_name COLLATE NOCASE");
  const sess = new Map(
    all<{ user_id: string; last: number; n: number }>(
      "SELECT user_id, MAX(last_seen_at) AS last, COUNT(*) AS n FROM sessions WHERE mfa_pending = 0 AND expires_at > ? GROUP BY user_id",
      t,
    ).map((r) => [r.user_id, r]),
  );
  const apps = new Map(all<{ user_id: string; n: number }>("SELECT user_id, COUNT(*) AS n FROM app_access GROUP BY user_id").map((r) => [r.user_id, r.n]));
  const folders = new Map(all<{ user_id: string; n: number }>("SELECT user_id, COUNT(*) AS n FROM file_grants GROUP BY user_id").map((r) => [r.user_id, r.n]));
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    mfa: !!u.totp_enabled,
    disabled: !!u.disabled,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    lastSeenAt: sess.get(u.id)?.last ?? null,
    sessions: sess.get(u.id)?.n ?? 0,
    appGrants: apps.get(u.id) ?? 0,
    folderGrants: folders.get(u.id) ?? 0,
    self: u.id === viewer.id,
  }));
}

export function personOrThrow(id: string): Row {
  const row = findById(id) as Row | undefined;
  if (!row) throw notFound("That person");
  return row;
}

const notSelf = (viewer: User, id: string, msg: string) => {
  if (viewer.id === id) throw new AppError("self", msg, 400);
};

// ---------------------------------------------------------------- invites

export function inviteLinks(token: string): { url: string; path: string } {
  const path = `/invite/${token}`;
  return { path, url: `${publicBaseUrl()}${path}` };
}

export function makeInvite(viewer: User, role: Role, displayName: string | null): CreatedInvite {
  const open = listInvites().length;
  if (open >= 20) throw new AppError("too_many", "There are already 20 unused invites. Cancel some first.", 409);
  const { token, invite } = createInvite(role, displayName?.trim() || null, viewer.id);
  return { id: invite.id, role: invite.role, displayName: invite.displayName, createdAt: invite.createdAt, expiresAt: invite.expiresAt, ...inviteLinks(token) };
}

export function openInvites(): InviteView[] {
  return listInvites().map((i) => ({ id: i.id, role: i.role, displayName: i.displayName, createdAt: i.createdAt, expiresAt: i.expiresAt }));
}

export function cancelInvite(id: string): InviteView {
  const inv = openInvites().find((i) => i.id === id);
  if (!inv) throw notFound("That invite");
  revokeInvite(id);
  return inv;
}

// ---------------------------------------------------------------- account changes

export function changeRole(id: string, role: Role): Row {
  const row = personOrThrow(id);
  if (row.role === role) return row;
  updateProfile(id, { role }); // refuses to demote the last admin
  if (role === "admin") {
    // Admin-only things they no longer need individually.
    run("DELETE FROM app_access WHERE user_id = ?", id);
  }
  return personOrThrow(id);
}

export function rename(id: string, displayName: string): Row {
  personOrThrow(id);
  updateProfile(id, { displayName });
  return personOrThrow(id);
}

export function setDisabled(viewer: User, id: string, disabled: boolean): Row {
  const row = personOrThrow(id);
  if (disabled) notSelf(viewer, id, "You can't turn off your own account.");
  if (!!row.disabled === disabled) return row;
  updateProfile(id, { disabled }); // signs them out everywhere; refuses the last admin
  return personOrThrow(id);
}

export function removePerson(viewer: User, id: string): Row {
  const row = personOrThrow(id);
  notSelf(viewer, id, "You can't remove your own account. Ask another admin.");
  tx(() => {
    // Their personal notification channels (channels.owner has no foreign key).
    const channels = all<{ id: string }>("SELECT id FROM channels WHERE owner = ?", id).map((r) => r.id);
    for (const c of channels) {
      run("UPDATE notify_deliveries SET status = 'cancelled', last_error = 'Person removed' WHERE channel_id = ? AND status = 'pending'", c);
      run("DELETE FROM channels WHERE id = ?", c);
    }
    deleteUser(id); // refuses the last admin; sessions, grants, subscriptions cascade
  });
  return row;
}

export async function resetPassword(viewer: User, id: string, password: string, mustChange: boolean): Promise<Row> {
  const row = personOrThrow(id);
  notSelf(viewer, id, "Change your own password in Settings → Security.");
  await setPassword(id, password); // validates strength
  run("DELETE FROM sessions WHERE user_id = ?", id);
  if (hasColumn("users", "must_change_password")) {
    run("UPDATE users SET must_change_password = ? WHERE id = ?", mustChange ? 1 : 0, id);
  } else if (mustChange) {
    // Migration not applied yet: the password is still reset, just without the prompt.
    console.warn("[gluon] users.must_change_password is missing; skipped the change-password prompt");
  }
  clearThrottle(row.username);
  return personOrThrow(id);
}

export function resetMfa(viewer: User, id: string): Row {
  const row = personOrThrow(id);
  notSelf(viewer, id, "Manage your own two-step verification in Settings → Security.");
  if (!row.totp_enabled) throw badRequest(`${row.display_name} doesn't have two-step verification on.`);
  disableTotp(id);
  return personOrThrow(id);
}

// ---------------------------------------------------------------- sessions

export function sessionsOf(id: string, viewerSessionHash: string): PersonSession[] {
  personOrThrow(id);
  return listSessions(id).map((s) => ({
    id: s.idHash.slice(0, 16),
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    ip: s.ip,
    zone: s.zone,
    userAgent: s.userAgent,
    current: s.idHash === viewerSessionHash,
  }));
}

/** Sign a person out of one device, or all of them (never the admin's own current session). */
export function revokeSessionsOf(id: string, which: { id: string } | { all: true }, viewerSessionHash: string): number {
  personOrThrow(id);
  const list = listSessions(id).filter((s) => s.idHash !== viewerSessionHash);
  const targets = "all" in which ? list : list.filter((s) => s.idHash.startsWith(which.id));
  if (!("all" in which) && targets.length === 0) throw notFound("That device");
  for (const s of targets) revokeSession(id, s.idHash);
  return targets.length;
}

export function describePerson(row: Pick<UserRow, "display_name" | "username">) {
  return `${row.display_name} (${row.username})`;
}

