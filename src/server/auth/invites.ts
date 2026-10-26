import "server-only";
import { all, now, one, run } from "../db";
import { sha256, token } from "../crypto";
import { AppError } from "../errors";
import { createUser, type Role, type User } from "./users";

interface InviteRow {
  token_hash: string;
  role: Role;
  display_name: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export interface Invite {
  id: string;
  role: Role;
  displayName: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

const DAYS = 7;

export function createInvite(role: Role, displayName: string | null, createdBy: string): { token: string; invite: Invite } {
  const raw = token(24);
  const t = now();
  run(
    "INSERT INTO invites (token_hash, role, display_name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    sha256(raw),
    role,
    displayName,
    createdBy,
    t,
    t + DAYS * 86_400_000,
  );
  return { token: raw, invite: { id: sha256(raw).slice(0, 16), role, displayName, createdAt: t, expiresAt: t + DAYS * 86_400_000, usedAt: null } };
}

export function listInvites(): Invite[] {
  return all<InviteRow>("SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC", now()).map((r) => ({
    id: r.token_hash.slice(0, 16),
    role: r.role,
    displayName: r.display_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
  }));
}

export function revokeInvite(id: string) {
  run("DELETE FROM invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL", id);
}

export function peekInvite(raw: string): InviteRow | null {
  const row = one<InviteRow>("SELECT * FROM invites WHERE token_hash = ?", sha256(raw));
  if (!row || row.used_at || row.expires_at < now()) return null;
  return row;
}

/**
 * Use an invite. The invite is claimed first (a single conditional UPDATE), so the same link opened
 * twice at once can only ever create one account; if creating the account then fails (username
 * taken), the claim is released so the person can try another name.
 */
export async function acceptInvite(raw: string, input: { username: string; displayName: string; password: string }): Promise<User> {
  const row = peekInvite(raw);
  if (!row) throw new AppError("invite_invalid", "This invite link has expired or was already used. Ask for a new one.", 410);
  const t = now();
  const claimed = run("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", t, row.token_hash, t).changes;
  if (!claimed) throw new AppError("invite_invalid", "This invite link has expired or was already used. Ask for a new one.", 410);
  try {
    const user = await createUser({ username: input.username, displayName: input.displayName || row.display_name || input.username, role: row.role, password: input.password });
    run("UPDATE invites SET used_by = ? WHERE token_hash = ?", user.id, row.token_hash);
    return user;
  } catch (e) {
    run("UPDATE invites SET used_at = NULL WHERE token_hash = ? AND used_by IS NULL", row.token_hash);
    throw e;
  }
}
