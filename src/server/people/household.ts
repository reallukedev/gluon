import "server-only";
import { all, now, one, run } from "../db";
import { id as newId } from "../crypto";
import { publish } from "../events";
import { AppError, forbidden, notFound } from "../errors";
import { raise, resolve } from "../findings";
import { findById, type User } from "../auth/users";
import { appsForMember, listApps } from "../docker/apps";
import { notifyReportReply } from "../notify/dispatcher";
import type { Announcement, ProblemReport } from "@/lib/people-types";
import { peopleHref } from "@/lib/settings-links";
import { hasColumn } from "./users";

async function appNames(): Promise<Map<string, string>> {
  try {
    return new Map((await listApps()).map((a) => [a.id, a.name]));
  } catch {
    return new Map();
  }
}

async function visibleApps(user: User): Promise<Set<string> | null> {
  if (user.role === "admin") return null; // everything
  try {
    return new Set((await appsForMember(user.id)).map((a) => a.id));
  } catch {
    return new Set();
  }
}

const nameOf = (id: string | null) => (id ? (findById(id)?.display_name ?? null) : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- problem reports

interface ReportRow {
  id: string;
  user_id: string | null;
  app_id: string | null;
  message: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  reply: string | null;
  replied_at?: number | null;
  replied_by?: string | null;
  acknowledged_at?: number | null;
  acknowledged_by?: string | null;
}

/**
 * "Seen" is newer than the reports table, so it's added on first use (ADD COLUMN is cheap and the
 * check is cached once true). No migration: a later ALTER in one would fail on servers that ran this.
 */
function ensureAcknowledged() {
  if (hasColumn("reports", "acknowledged_at")) return;
  try {
    run("ALTER TABLE reports ADD COLUMN acknowledged_at INTEGER");
    run("ALTER TABLE reports ADD COLUMN acknowledged_by TEXT");
  } catch {
    /* another request added it first */
  }
}

const reportFindingId = (id: string) => `report:${id}`;

function toReport(r: ReportRow, names: Map<string, string>): ProblemReport {
  return {
    id: r.id,
    userId: r.user_id,
    userName: nameOf(r.user_id),
    appId: r.app_id,
    appName: r.app_id ? (names.get(r.app_id) ?? r.app_id) : null,
    message: r.message,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByName: nameOf(r.resolved_by),
    reply: r.reply,
    repliedAt: r.replied_at ?? null,
    repliedByName: nameOf(r.replied_by ?? null),
    // A reply counts as seen, even from before "seen" existed.
    acknowledgedAt: r.acknowledged_at ?? r.replied_at ?? null,
    acknowledgedByName: nameOf(r.acknowledged_by ?? r.replied_by ?? null),
  };
}

const HOUR = 3_600_000;
const MAX_PER_HOUR = 5;
const MIN_GAP_MS = 30_000;

export async function createReport(user: User, input: { appId?: string | null; message: string }): Promise<ProblemReport> {
  const message = input.message.trim();
  if (message.length < 1 || message.length > 1000) throw new AppError("invalid", "Say what's wrong in up to 1000 characters.", 400, { field: "message" });
  const t = now();
  const recent = all<{ created_at: number }>("SELECT created_at FROM reports WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC", user.id, t - HOUR);
  if (recent.length && t - recent[0]!.created_at < MIN_GAP_MS) {
    throw new AppError("rate_limited", "You just sent a report. Give it a moment before sending another.", 429);
  }
  if (recent.length >= MAX_PER_HOUR) {
    throw new AppError("rate_limited", "You've sent several reports this hour. They've all been passed on; the admin will look at them.", 429);
  }
  const names = await appNames();
  let appId = input.appId || null;
  if (appId) {
    const visible = await visibleApps(user);
    if ((visible && !visible.has(appId)) || !names.has(appId)) throw forbidden("You can only report apps you can see.");
  }
  const id = newId();
  run("INSERT INTO reports (id, user_id, app_id, message, created_at) VALUES (?, ?, ?, ?, ?)", id, user.id, appId, message, t);
  const appName = appId ? names.get(appId)! : null;
  raise({
    id: reportFindingId(id),
    kind: "household.report",
    severity: "attention",
    subject: appId,
    title: appName ? `${user.displayName} says ${appName} isn't working` : `${user.displayName} reported a problem`,
    cause: `“${clip(message, 400)}”`,
    detail: { reportId: id, userId: user.id, appId },
    remedy: { action: "", label: "Reply", href: peopleHref({ tab: "reports", report: id }) },
  });
  publish("reports", { id, change: "created" });
  return toReport(one<ReportRow>("SELECT * FROM reports WHERE id = ?", id)!, names);
}

export async function listReports(viewer: User, opts: { status?: "open" | "resolved" | "all"; limit?: number } = {}): Promise<ProblemReport[]> {
  ensureAcknowledged();
  const where: string[] = [];
  const params: unknown[] = [];
  if (viewer.role !== "admin") (where.push("user_id = ?"), params.push(viewer.id));
  if (opts.status === "open") where.push("resolved_at IS NULL");
  if (opts.status === "resolved") where.push("resolved_at IS NOT NULL");
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = all<ReportRow>(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY resolved_at IS NOT NULL, created_at DESC LIMIT ${limit}`, ...params);
  const names = await appNames();
  return rows.map((r) => toReport(r, names));
}

function reportOrThrow(id: string): ReportRow {
  const r = one<ReportRow>("SELECT * FROM reports WHERE id = ?", id);
  if (!r) throw notFound("That report");
  return r;
}

/** Admin: reply and/or mark resolved (or reopen). A reply notifies the reporter. */
export async function answerReport(admin: User, id: string, input: { reply?: string | null; resolved?: boolean; acknowledged?: boolean }): Promise<ProblemReport> {
  ensureAcknowledged();
  const r = reportOrThrow(id);
  const t = now();
  // Seen: set by "Mark as seen", by a reply, or by resolving; cleared only on request.
  const seen = input.acknowledged ?? (input.reply || input.resolved === true ? true : undefined);
  if (seen === true && !r.acknowledged_at) run("UPDATE reports SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?", t, admin.id, id);
  if (input.acknowledged === false) run("UPDATE reports SET acknowledged_at = NULL, acknowledged_by = NULL WHERE id = ?", id);
  if (input.reply !== undefined) {
    const reply = input.reply?.trim() || null;
    if (reply && reply.length > 1000) throw new AppError("invalid", "Keep the reply under 1000 characters.", 400, { field: "reply" });
    if (hasColumn("reports", "replied_at")) {
      run("UPDATE reports SET reply = ?, replied_at = ?, replied_by = ? WHERE id = ?", reply, reply ? t : null, reply ? admin.id : null, id);
    } else {
      run("UPDATE reports SET reply = ? WHERE id = ?", reply, id);
    }
    if (reply && reply !== r.reply) {
      const names = await appNames();
      notifyReportReply({ id, userId: r.user_id, appName: r.app_id ? (names.get(r.app_id) ?? null) : null, reply, repliedAt: t }, admin.displayName);
    }
  }
  if (input.resolved === true && !r.resolved_at) {
    run("UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE id = ?", t, admin.id, id);
    resolve(reportFindingId(id), `${admin.displayName} resolved a problem report`);
  } else if (input.resolved === false && r.resolved_at) {
    run("UPDATE reports SET resolved_at = NULL, resolved_by = NULL WHERE id = ?", id);
    const who = nameOf(r.user_id) ?? "Someone";
    const names = await appNames();
    const appName = r.app_id ? names.get(r.app_id) : null;
    raise({
      id: reportFindingId(id),
      kind: "household.report",
      severity: "attention",
      subject: r.app_id,
      title: appName ? `${who} says ${appName} isn't working` : `${who} reported a problem`,
      cause: `“${clip(r.message, 400)}”`,
      detail: { reportId: id, userId: r.user_id, appId: r.app_id },
      remedy: { action: "", label: "Reply", href: peopleHref({ tab: "reports", report: id }) },
    });
  }
  publish("reports", { id, change: "updated" });
  const names = await appNames();
  return toReport(reportOrThrow(id), names);
}

/** The reporter can withdraw an open report; admins can delete any. */
export function deleteReport(viewer: User, id: string): ReportRow {
  const r = reportOrThrow(id);
  if (viewer.role !== "admin") {
    if (r.user_id !== viewer.id) throw notFound("That report");
    if (r.resolved_at) throw new AppError("resolved", "That report is already dealt with.", 409);
  }
  run("DELETE FROM reports WHERE id = ?", id);
  resolve(reportFindingId(id), viewer.role === "admin" ? "Problem report removed" : `${viewer.displayName} withdrew their problem report`);
  publish("reports", { id, change: "deleted" });
  return r;
}

// ---------------------------------------------------------------- announcements

interface AnnRow {
  id: string;
  message: string;
  app_id: string | null;
  created_by: string | null;
  created_at: number;
  until: number | null;
}

function toAnn(r: AnnRow, names: Map<string, string>, t: number): Announcement {
  return {
    id: r.id,
    message: r.message,
    appId: r.app_id,
    appName: r.app_id ? (names.get(r.app_id) ?? r.app_id) : null,
    createdBy: r.created_by,
    createdByName: nameOf(r.created_by),
    createdAt: r.created_at,
    until: r.until,
    active: r.until === null || r.until > t,
  };
}

/** Active announcements the viewer should see (members: none about apps they can't see). Admins can ask for all. */
/**
 * The raw current announcements a person should see (the shell banner, Status): an app-scoped one
 * only reaches people who can open that app.
 */
export async function currentAnnouncements(viewer: User, limit?: number): Promise<{ id: string; message: string; app_id: string | null; until: number | null }[]> {
  const rows = all<{ id: string; message: string; app_id: string | null; until: number | null }>(
    "SELECT id, message, app_id, until FROM announcements WHERE until IS NULL OR until > ? ORDER BY created_at DESC",
    now(),
  );
  const visible = await visibleApps(viewer);
  const mine = rows.filter((r) => !r.app_id || !visible || visible.has(r.app_id));
  return limit ? mine.slice(0, limit) : mine;
}

export async function listAnnouncements(viewer: User, includeExpired = false): Promise<Announcement[]> {
  const t = now();
  const rows = all<AnnRow>(
    `SELECT * FROM announcements ${includeExpired && viewer.role === "admin" ? "" : "WHERE until IS NULL OR until > ?"} ORDER BY created_at DESC LIMIT 100`,
    ...(includeExpired && viewer.role === "admin" ? [] : [t]),
  );
  const visible = await visibleApps(viewer);
  const names = await appNames();
  return rows.filter((r) => !r.app_id || !visible || visible.has(r.app_id)).map((r) => toAnn(r, names, t));
}

function checkAnn(input: { message?: string; until?: number | null; appId?: string | null }, names: Map<string, string>) {
  if (input.message !== undefined) {
    const m = input.message.trim();
    if (!m || m.length > 500) throw new AppError("invalid", "Write the announcement in up to 500 characters.", 400, { field: "message" });
  }
  if (input.until !== undefined && input.until !== null && input.until <= now()) {
    throw new AppError("invalid", "Pick an end time in the future (or leave it empty to show it until you remove it).", 400, { field: "until" });
  }
  if (input.appId && !names.has(input.appId)) throw notFound("That app");
}

export async function createAnnouncement(admin: User, input: { message: string; appId?: string | null; until?: number | null }): Promise<Announcement> {
  const names = await appNames();
  checkAnn(input, names);
  const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM announcements WHERE until IS NULL OR until > ?", now())?.n ?? 0;
  if (n >= 10) throw new AppError("too_many", "There are already 10 announcements showing. Remove one first.", 409);
  const id = newId();
  run("INSERT INTO announcements (id, message, app_id, created_by, created_at, until) VALUES (?, ?, ?, ?, ?, ?)", id, input.message.trim(), input.appId || null, admin.id, now(), input.until ?? null);
  publish("announcements", { id, change: "created" });
  return toAnn(one<AnnRow>("SELECT * FROM announcements WHERE id = ?", id)!, names, now());
}

export async function updateAnnouncement(id: string, input: { message?: string; appId?: string | null; until?: number | null }): Promise<Announcement> {
  const cur = one<AnnRow>("SELECT * FROM announcements WHERE id = ?", id);
  if (!cur) throw notFound("That announcement");
  const names = await appNames();
  checkAnn(input, names);
  run(
    "UPDATE announcements SET message = ?, app_id = ?, until = ? WHERE id = ?",
    input.message !== undefined ? input.message.trim() : cur.message,
    input.appId !== undefined ? input.appId || null : cur.app_id,
    input.until !== undefined ? input.until : cur.until,
    id,
  );
  publish("announcements", { id, change: "updated" });
  return toAnn(one<AnnRow>("SELECT * FROM announcements WHERE id = ?", id)!, names, now());
}

export function deleteAnnouncement(id: string): AnnRow {
  const cur = one<AnnRow>("SELECT * FROM announcements WHERE id = ?", id);
  if (!cur) throw notFound("That announcement");
  run("DELETE FROM announcements WHERE id = ?", id);
  publish("announcements", { id, change: "deleted" });
  return cur;
}

/** Drop announcements that ended more than 30 days ago. */
export function pruneAnnouncements() {
  run("DELETE FROM announcements WHERE until IS NOT NULL AND until < ?", now() - 30 * 86_400_000);
}
