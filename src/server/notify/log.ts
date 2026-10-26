import "server-only";
import { all, now, one, run } from "../db";
import { AppError, notFound } from "../errors";
import type { User } from "../auth/users";
import type { DeliveryEntry, DeliveryEvent, DeliveryPage, DeliveryStatus } from "@/lib/alerts-types";
import type { DeliveryRow } from "./dispatcher";
import { kick } from "./dispatcher";

const toEntry = (r: DeliveryRow): DeliveryEntry => ({
  id: r.id,
  createdAt: r.created_at,
  channelId: r.channel_id,
  channelName: r.channel_name,
  channelKind: r.channel_kind,
  userId: r.user_id,
  event: r.event,
  findingId: r.finding_id,
  severity: r.severity,
  title: r.title,
  body: r.body,
  link: r.link,
  status: r.status,
  notBefore: r.not_before,
  nextAttemptAt: r.next_attempt_at,
  attempts: r.attempts,
  lastError: r.last_error,
  sentAt: r.sent_at,
});

/** Members see deliveries to their own channels (or addressed to them); admins see everything. */
function scope(viewer: User): { sql: string; params: unknown[] } {
  if (viewer.role === "admin") return { sql: "1 = 1", params: [] };
  return { sql: "(user_id = ? OR channel_id IN (SELECT id FROM channels WHERE owner = ?))", params: [viewer.id, viewer.id] };
}

export function listDeliveries(
  viewer: User,
  q: { before?: number; limit?: number; channel?: string; status?: DeliveryStatus; event?: DeliveryEvent; finding?: string },
): DeliveryPage {
  const s = scope(viewer);
  const where = [s.sql];
  const params = [...s.params];
  if (q.before) (where.push("id < ?"), params.push(q.before));
  if (q.channel) (where.push("channel_id = ?"), params.push(q.channel));
  if (q.status) (where.push("status = ?"), params.push(q.status));
  if (q.event) (where.push("event = ?"), params.push(q.event));
  if (q.finding) (where.push("finding_id = ?"), params.push(q.finding));
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = all<DeliveryRow>(`SELECT * FROM notify_deliveries WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit + 1}`, ...params);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(toEntry);
  return { items, next: more ? items[items.length - 1]!.id : null };
}

/** Send a failed message again now. */
export function retryDelivery(viewer: User, id: number): DeliveryEntry {
  const s = scope(viewer);
  const r = one<DeliveryRow>(`SELECT * FROM notify_deliveries WHERE id = ? AND ${s.sql}`, id, ...s.params);
  if (!r) throw notFound("That message");
  if (r.status !== "failed") throw new AppError("not_failed", "Only messages that failed can be sent again.", 409);
  if (!r.channel_id) throw new AppError("channel_gone", "The channel it was for has been removed.", 409);
  const t = now();
  run("UPDATE notify_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, not_before = ?, last_error = NULL WHERE id = ?", t, t, id);
  kick(500);
  return toEntry(one<DeliveryRow>("SELECT * FROM notify_deliveries WHERE id = ?", id)!);
}
