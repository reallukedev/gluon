import "server-only";
import { all, now, run } from "./db";
import { publish } from "./events";
import type { User } from "./auth/users";

export interface ActivityEntry {
  id: number;
  at: number;
  userId: string | null;
  username: string | null;
  kind: "user" | "system";
  action: string;
  target: string | null;
  summary: string;
  detail: unknown;
  ip: string | null;
  zone: string | null;
  outcome: "ok" | "failed";
}

interface Row {
  id: number;
  at: number;
  user_id: string | null;
  username: string | null;
  kind: "user" | "system";
  action: string;
  target: string | null;
  summary: string;
  detail: string | null;
  ip: string | null;
  zone: string | null;
  outcome: "ok" | "failed";
}

const toEntry = (r: Row): ActivityEntry => ({
  id: r.id,
  at: r.at,
  userId: r.user_id,
  username: r.username,
  kind: r.kind,
  action: r.action,
  target: r.target,
  summary: r.summary,
  detail: r.detail ? JSON.parse(r.detail) : null,
  ip: r.ip,
  zone: r.zone,
  outcome: r.outcome,
});

export interface AuditInput {
  action: string;
  summary: string;
  target?: string | null;
  detail?: unknown;
  outcome?: "ok" | "failed";
}

/** Record something a person did. `summary` is a plain sentence: "Restarted Jellyfin". */
export function audit(user: Pick<User, "id" | "username"> | null, input: AuditInput, where?: { ip?: string; zone?: string }) {
  const info = run(
    `INSERT INTO audit_log (at, user_id, username, kind, action, target, summary, detail, ip, zone, outcome)
     VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
    now(),
    user?.id ?? null,
    user?.username ?? null,
    input.action,
    input.target ?? null,
    input.summary,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    where?.ip ?? null,
    where?.zone ?? null,
    input.outcome ?? "ok",
  );
  publish("activity", { id: Number(info.lastInsertRowid) });
}

/** Record something the server noticed or did on its own: "Jellyfin restarted after crashing". */
export function systemEvent(input: AuditInput) {
  const info = run(
    `INSERT INTO audit_log (at, kind, action, target, summary, detail, outcome) VALUES (?, 'system', ?, ?, ?, ?, ?)`,
    now(),
    input.action,
    input.target ?? null,
    input.summary,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    input.outcome ?? "ok",
  );
  publish("activity", { id: Number(info.lastInsertRowid) });
}

export function listActivity(opts: { before?: number; limit?: number; kind?: "user" | "system"; userId?: string; q?: string; target?: string; outcome?: "ok" | "failed" }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.before) (where.push("id < ?"), params.push(opts.before));
  if (opts.kind) (where.push("kind = ?"), params.push(opts.kind));
  if (opts.userId) (where.push("user_id = ?"), params.push(opts.userId));
  if (opts.target) (where.push("target = ?"), params.push(opts.target));
  if (opts.outcome) (where.push("outcome = ?"), params.push(opts.outcome));
  if (opts.q) (where.push("(summary LIKE ? OR target LIKE ? OR action LIKE ?)"), params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`));
  const limit = Math.min(opts.limit ?? 50, 200);
  return all<Row>(
    `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`,
    ...params,
  ).map(toEntry);
}

export function pruneActivity() {
  run("DELETE FROM audit_log WHERE at < ?", now() - 365 * 86_400_000);
}
