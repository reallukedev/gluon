import "server-only";
import { all, now, one, run } from "./db";
import { publish } from "./events";
import { systemEvent } from "./audit";

export type Severity = "fault" | "attention" | "info";

/** A one-click fix the server knows how to perform. `action` maps to a handler in alerts/remedies. */
export interface Remedy {
  action: string;
  label: string;
  params?: Record<string, unknown>;
  /** Shown before running; destructive remedies confirm first. */
  confirm?: { title: string; consequences: string[]; typeToConfirm?: string };
  /** Or a place to go instead of an in-place action. */
  href?: string;
}

export interface Finding {
  id: string;
  kind: string;
  severity: Severity;
  subject: string | null;
  title: string;
  cause: string | null;
  detail: Record<string, unknown> | null;
  remedy: Remedy | null;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  snoozedUntil: number | null;
  dismissedAt: number | null;
}

interface Row {
  id: string;
  kind: string;
  severity: Severity;
  subject: string | null;
  title: string;
  cause: string | null;
  detail: string | null;
  remedy: string | null;
  first_seen: number;
  last_seen: number;
  resolved_at: number | null;
  snoozed_until: number | null;
  dismissed_at: number | null;
  notified_at: number | null;
}

const toFinding = (r: Row): Finding => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  subject: r.subject,
  title: r.title,
  cause: r.cause,
  detail: r.detail ? JSON.parse(r.detail) : null,
  remedy: r.remedy ? JSON.parse(r.remedy) : null,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  resolvedAt: r.resolved_at,
  snoozedUntil: r.snoozed_until,
  dismissedAt: r.dismissed_at,
});

export interface FindingInput {
  id: string;
  kind: string;
  severity: Severity;
  subject?: string | null;
  title: string;
  cause?: string | null;
  detail?: Record<string, unknown> | null;
  remedy?: Remedy | null;
}

/**
 * Record that a condition is currently true. Idempotent: the same id updates in place.
 * Returns "new" when it (re)opened, so the caller can notify.
 */
export function raise(f: FindingInput): "new" | "updated" {
  const t = now();
  const existing = one<Row>("SELECT * FROM findings WHERE id = ?", f.id);
  const detail = f.detail ? JSON.stringify(f.detail) : null;
  const remedy = f.remedy ? JSON.stringify(f.remedy) : null;
  if (!existing || existing.resolved_at) {
    run(
      `INSERT INTO findings (id, kind, severity, subject, title, cause, detail, remedy, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, severity = excluded.severity, subject = excluded.subject,
         title = excluded.title, cause = excluded.cause, detail = excluded.detail, remedy = excluded.remedy,
         first_seen = excluded.first_seen, last_seen = excluded.last_seen, resolved_at = NULL, notified_at = NULL,
         dismissed_at = NULL, dismissed_by = NULL`,
      f.id,
      f.kind,
      f.severity,
      f.subject ?? null,
      f.title,
      f.cause ?? null,
      detail,
      remedy,
      t,
      t,
    );
    publish("findings", { id: f.id, change: "opened" });
    if (f.severity !== "info") systemEvent({ action: `finding.${f.kind}`, target: f.subject ?? null, summary: f.title, outcome: f.severity === "fault" ? "failed" : "ok" });
    return "new";
  }
  const changed = existing.severity !== f.severity || existing.title !== f.title || existing.cause !== (f.cause ?? null) || existing.detail !== detail;
  run(
    "UPDATE findings SET severity = ?, subject = ?, title = ?, cause = ?, detail = ?, remedy = ?, last_seen = ? WHERE id = ?",
    f.severity,
    f.subject ?? null,
    f.title,
    f.cause ?? null,
    detail,
    remedy,
    t,
    f.id,
  );
  if (changed) publish("findings", { id: f.id, change: "updated" });
  return "updated";
}

/** The condition is no longer true. */
export function resolve(id: string, note?: string) {
  const r = one<Row>("SELECT * FROM findings WHERE id = ? AND resolved_at IS NULL", id);
  if (!r) return false;
  run("UPDATE findings SET resolved_at = ? WHERE id = ?", now(), id);
  publish("findings", { id, change: "resolved" });
  if (r.severity !== "info") systemEvent({ action: `finding.${r.kind}.resolved`, target: r.subject, summary: note ?? `Resolved: ${r.title}` });
  return true;
}

/** Resolve every open finding of `kind` whose id isn't in `stillTrue`. Used by checks that enumerate. */
export function resolveMissing(kind: string, stillTrue: Set<string>) {
  const open = all<{ id: string }>("SELECT id FROM findings WHERE kind = ? AND resolved_at IS NULL", kind);
  for (const { id } of open) if (!stillTrue.has(id)) resolve(id);
}

export function listOpen(opts: { includeSnoozed?: boolean; includeInfo?: boolean } = {}): Finding[] {
  const t = now();
  return all<Row>(
    `SELECT * FROM findings WHERE resolved_at IS NULL AND dismissed_at IS NULL
     ${opts.includeSnoozed ? "" : "AND (snoozed_until IS NULL OR snoozed_until < ?)"}
     ${opts.includeInfo ? "" : "AND severity != 'info'"}
     ORDER BY CASE severity WHEN 'fault' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END, first_seen DESC`,
    ...(opts.includeSnoozed ? [] : [t]),
  ).map(toFinding);
}

export function listAllOpen(): Finding[] {
  return all<Row>(
    "SELECT * FROM findings WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'fault' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END, first_seen DESC",
  ).map(toFinding);
}

export function listHistory(limit = 100): Finding[] {
  return all<Row>("SELECT * FROM findings WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?", limit).map(toFinding);
}

export function getFinding(id: string): Finding | null {
  const r = one<Row>("SELECT * FROM findings WHERE id = ?", id);
  return r ? toFinding(r) : null;
}

export function snooze(id: string, until: number) {
  run("UPDATE findings SET snoozed_until = ? WHERE id = ?", until, id);
  publish("findings", { id, change: "snoozed" });
}

export function dismiss(id: string, userId: string) {
  run("UPDATE findings SET dismissed_at = ?, dismissed_by = ? WHERE id = ?", now(), userId, id);
  publish("findings", { id, change: "dismissed" });
}

export function undismiss(id: string) {
  run("UPDATE findings SET dismissed_at = NULL, dismissed_by = NULL, snoozed_until = NULL WHERE id = ?", id);
  publish("findings", { id, change: "restored" });
}

export function markNotified(id: string) {
  run("UPDATE findings SET notified_at = ? WHERE id = ?", now(), id);
}

export function needsNotification(): Finding[] {
  return all<Row>(
    "SELECT * FROM findings WHERE resolved_at IS NULL AND dismissed_at IS NULL AND notified_at IS NULL AND severity != 'info' AND (snoozed_until IS NULL OR snoozed_until < ?)",
    now(),
  ).map(toFinding);
}

export function counts() {
  const t = now();
  const r = one<{ fault: number; attention: number }>(
    `SELECT SUM(severity = 'fault') AS fault, SUM(severity = 'attention') AS attention FROM findings
     WHERE resolved_at IS NULL AND dismissed_at IS NULL AND (snoozed_until IS NULL OR snoozed_until < ?)`,
    t,
  );
  return { fault: r?.fault ?? 0, attention: r?.attention ?? 0 };
}
