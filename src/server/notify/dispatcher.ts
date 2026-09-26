import "server-only";
import { all, now, one, run } from "../db";
import { getSetting } from "../settings";
import { findById } from "../auth/users";
import { listApps, appsForMember } from "../docker/apps";
import { getFinding, markNotified, needsNotification, raise, resolve, type Finding } from "../findings";
import type { ChannelKind, DeliveryEvent } from "@/lib/alerts-types";
import { getChannel, sendContext, type Channel } from "./channels";
import { activeSubscriptions, localParts, quietState, wants, type ActiveSub } from "./subscriptions";
import { batchMessage, digestMessage, problemMessage, reportReplyMessage, resolvedMessage, type Composed } from "./messages";
import { deliver, DeliveryError, type MessageLevel, type OutMessage } from "./transports";

/**
 * The notification pipeline, all backed by the notify_deliveries table (queue + history):
 *
 *   fanOut     new findings (needsNotification) → one row per interested channel, delayed past quiet
 *              hours unless it's a fault and the person lets faults through; then markNotified.
 *   followUps  problem rows whose finding cleared → cancel if unsent, else queue a "resolved" row.
 *   digests    once a day per subscribed channel at settings.digest.hour in the subscriber's zone.
 *   sendDue    deliver due rows; 4+ at once to a channel are combined; failures back off and retry.
 *
 * Dedupe: dedupe_key is UNIQUE (channel | event | finding | episode), so two admins subscribed to
 * the same channel get one message, and restarts never resend.
 */

const TICK_MS = 15_000;
const BATCH_AT = 4;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const MAX_ATTEMPTS = 7;
const MAX_ATTEMPTS_PERMANENT = 3;
const RETENTION_MS = 90 * 86_400_000;

export interface DeliveryRow {
  id: number;
  created_at: number;
  channel_id: string | null;
  channel_name: string;
  channel_kind: ChannelKind | null;
  user_id: string | null;
  event: DeliveryEvent;
  finding_id: string | null;
  episode: number | null;
  dedupe_key: string;
  severity: "fault" | "attention" | "info" | null;
  title: string;
  body: string;
  link: string | null;
  link_label: string | null;
  status: "pending" | "sent" | "failed" | "cancelled";
  not_before: number;
  next_attempt_at: number;
  attempts: number;
  last_error: string | null;
  sent_at: number | null;
  followed_up: number;
}

// ---------------------------------------------------------------- queue helpers

function enqueue(d: { channel: Channel; userId: string | null; event: DeliveryEvent; findingId?: string | null; episode?: number | null; dedupe: string; msg: Composed; notBefore: number }): boolean {
  const t = now();
  const info = run(
    `INSERT OR IGNORE INTO notify_deliveries
      (created_at, channel_id, channel_name, channel_kind, user_id, event, finding_id, episode, dedupe_key, severity, title, body, link, link_label,
       status, not_before, next_attempt_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
    t,
    d.channel.id,
    d.channel.name,
    d.channel.kind,
    d.userId,
    d.event,
    d.findingId ?? null,
    d.episode ?? null,
    d.dedupe,
    d.msg.severity,
    d.msg.title,
    d.msg.body,
    d.msg.link,
    d.msg.linkLabel,
    d.notBefore,
    d.notBefore,
  );
  return info.changes > 0;
}

const cancel = (ids: number[], why: string) => {
  for (const id of ids) run("UPDATE notify_deliveries SET status = 'cancelled', last_error = ? WHERE id = ? AND status = 'pending'", why, id);
};

/** When a message for these subscribers may go out: now, or the earliest end of their quiet hours. */
function releaseAt(subs: ActiveSub[], t: number, severity: string | null, allowBypass: boolean): number {
  let best = Infinity;
  for (const s of subs) {
    const q = quietState(s.filter, t);
    const bypass = allowBypass && severity === "fault" && !!s.filter.quiet?.bypassFaults;
    const at = q.quiet && !bypass ? (q.endsAt ?? t) : t;
    best = Math.min(best, at);
  }
  return Number.isFinite(best) ? best : t;
}

function byChannel(subs: ActiveSub[]): Map<string, ActiveSub[]> {
  const m = new Map<string, ActiveSub[]>();
  for (const s of subs) {
    const arr = m.get(s.channel.id) ?? [];
    arr.push(s);
    m.set(s.channel.id, arr);
  }
  return m;
}

// ---------------------------------------------------------------- app names (for member wording)

let appNames = new Map<string, string>();
async function refreshAppNames() {
  try {
    appNames = new Map((await listApps()).map((a) => [a.id, a.name]));
  } catch {
    /* keep the last known names */
  }
}
const appName = (subject: string | null) => (subject ? (appNames.get(subject) ?? null) : null);

// ---------------------------------------------------------------- fan out

async function fanOut() {
  const findings = needsNotification();
  if (!findings.length) return;
  const subs = activeSubscriptions();
  const memberApps = new Map<string, Set<string>>();
  for (const s of subs) {
    if (s.role === "admin" || memberApps.has(s.userId)) continue;
    try {
      memberApps.set(s.userId, new Set((await appsForMember(s.userId)).map((a) => a.id)));
    } catch {
      memberApps.set(s.userId, new Set());
    }
  }
  const t = now();
  const channels = byChannel(subs);
  for (const f of findings) {
    for (const [channelId, chSubs] of channels) {
      if (f.kind === "notify.channel" && (f.detail as { channelId?: string } | null)?.channelId === channelId) continue;
      const interested = chSubs.filter((s) => wants(s, f, memberApps.get(s.userId) ?? null));
      if (!interested.length) continue;
      const lead = interested.find((s) => s.role === "admin") ?? interested[0]!;
      enqueue({
        channel: lead.channel,
        userId: lead.userId,
        event: "problem",
        findingId: f.id,
        episode: f.firstSeen,
        dedupe: `${channelId}|problem|${f.id}|${f.firstSeen}`,
        msg: problemMessage(f, lead.role, appName(f.subject), lead.filter),
        notBefore: releaseAt(interested, t, f.severity, true),
      });
    }
    markNotified(f.id);
  }
}

// ---------------------------------------------------------------- follow-ups (resolved)

interface FollowRow {
  id: number;
  channel_id: string | null;
  status: DeliveryRow["status"];
  finding_id: string;
  episode: number;
  f_id: string | null;
  kind: string | null;
  title: string | null;
  subject: string | null;
  severity: Finding["severity"] | null;
  first_seen: number | null;
  resolved_at: number | null;
  dismissed_at: number | null;
}

/** Synchronous (DB only) so it can run straight from the findings event. */
export function followUps() {
  const rows = all<FollowRow>(
    `SELECT d.id, d.channel_id, d.status, d.finding_id, d.episode,
            f.id AS f_id, f.kind, f.title, f.subject, f.severity, f.first_seen, f.resolved_at, f.dismissed_at
     FROM notify_deliveries d LEFT JOIN findings f ON f.id = d.finding_id
     WHERE d.event = 'problem' AND d.followed_up = 0 AND d.finding_id IS NOT NULL
       AND (f.id IS NULL OR f.resolved_at IS NOT NULL OR f.dismissed_at IS NOT NULL OR f.first_seen != d.episode)`,
  );
  if (!rows.length) return;
  const subs = byChannel(activeSubscriptions());
  const t = now();
  for (const r of rows) {
    run("UPDATE notify_deliveries SET followed_up = 1 WHERE id = ?", r.id);
    if (r.status === "pending") {
      cancel([r.id], r.dismissed_at ? "Marked as not a problem before it was sent" : "Cleared before it was sent");
      continue;
    }
    const cleanlyResolved = r.status === "sent" && r.f_id && r.resolved_at !== null && r.dismissed_at === null && r.first_seen === r.episode;
    if (!cleanlyResolved || !r.channel_id) continue;
    const interested = (subs.get(r.channel_id) ?? []).filter((s) => s.filter.resolved);
    if (!interested.length) continue;
    const lead = interested.find((s) => s.role === "admin") ?? interested[0]!;
    enqueue({
      channel: lead.channel,
      userId: lead.userId,
      event: "resolved",
      findingId: r.finding_id,
      episode: r.episode,
      dedupe: `${r.channel_id}|resolved|${r.finding_id}|${r.episode}`,
      msg: resolvedMessage({ id: r.finding_id, title: r.title ?? "", firstSeen: r.first_seen ?? r.episode, resolvedAt: r.resolved_at, severity: r.severity ?? "attention" }, lead.role, appName(r.subject)),
      notBefore: releaseAt(interested, t, null, false),
    });
  }
}

// ---------------------------------------------------------------- digest

function digests() {
  const d = getSetting("digest");
  if (!d.enabled) return;
  const subs = activeSubscriptions().filter((s) => s.role === "admin" && s.filter.digest);
  if (!subs.length) return;
  const t = now();
  let msg: Composed | null = null;
  for (const [channelId, chSubs] of byChannel(subs)) {
    for (const s of chSubs) {
      const local = localParts(t, s.filter.tz);
      if (local.hour !== d.hour) continue;
      const dedupe = `${channelId}|digest|${local.date}`;
      if (one<{ id: number }>("SELECT id FROM notify_deliveries WHERE dedupe_key = ?", dedupe)) break;
      msg ??= digestMessage();
      enqueue({ channel: s.channel, userId: s.userId, event: "digest", dedupe, msg, notBefore: t });
      break;
    }
  }
}

// ---------------------------------------------------------------- report replies

/** Tell the person who reported a problem that an admin replied. */
export function notifyReportReply(report: { id: string; userId: string | null; appName: string | null; reply: string; repliedAt: number }, adminName: string) {
  if (!report.userId) return;
  const subs = activeSubscriptions().filter((s) => s.userId === report.userId && s.filter.reports);
  const t = now();
  for (const s of subs) {
    enqueue({
      channel: s.channel,
      userId: s.userId,
      event: "report",
      dedupe: `${s.channel.id}|report|${report.id}|${report.repliedAt}`,
      msg: reportReplyMessage(report, adminName),
      notBefore: releaseAt([s], t, null, false),
    });
  }
  kick();
}

// ---------------------------------------------------------------- sending

function level(r: Pick<DeliveryRow, "event" | "severity">): MessageLevel {
  if (r.event === "resolved") return "resolved";
  if (r.event === "digest") return "digest";
  if (r.event === "report") return "info";
  return r.severity === "fault" ? "fault" : r.severity === "attention" ? "attention" : "info";
}

function outOf(r: DeliveryRow, subject: string | null): OutMessage {
  return {
    title: r.title,
    body: r.body,
    link: r.link,
    linkLabel: r.link_label,
    level: level(r),
    event: r.event,
    findingId: r.finding_id,
    severity: r.severity,
    subject,
    at: r.created_at,
    serverName: getSetting("serverName"),
  };
}

function channelFailing(ch: Channel, error: string) {
  const owner = ch.owner ? findById(ch.owner) : null;
  if (ch.owner && owner?.role !== "admin") return; // members see their own channel's state in the log
  raise({
    id: `notify.channel:${ch.id}`,
    kind: "notify.channel",
    severity: "attention",
    subject: null,
    title: `Alerts to “${ch.name}” aren't getting through`,
    cause: error,
    detail: { channelId: ch.id },
    remedy: { action: "", label: "Check the channel", href: `/alerts?tab=channels&channel=${encodeURIComponent(ch.id)}` },
  });
}

async function attempt(ch: Channel, rows: DeliveryRow[], msg: OutMessage): Promise<boolean> {
  const t = now();
  try {
    await deliver(ch.kind, ch.config, msg, sendContext(ch));
    for (const r of rows) run("UPDATE notify_deliveries SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?", now(), r.id);
    resolve(`notify.channel:${ch.id}`, `Alerts to “${ch.name}” are getting through again`);
    return true;
  } catch (e) {
    const permanent = e instanceof DeliveryError && e.permanent;
    const message = e instanceof DeliveryError ? e.message : `Sending failed: ${(e as Error).message}`;
    let worst = 0;
    for (const r of rows) {
      const attempts = r.attempts + 1;
      worst = Math.max(worst, attempts);
      const give = attempts >= (permanent ? MAX_ATTEMPTS_PERMANENT : MAX_ATTEMPTS);
      run(
        "UPDATE notify_deliveries SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?",
        attempts,
        message,
        give ? "failed" : "pending",
        t + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!,
        r.id,
      );
    }
    if (worst >= 2) channelFailing(ch, message);
    return false;
  }
}

async function sendGroup(channelId: string, rows: DeliveryRow[]) {
  const ch = getChannel(channelId);
  if (!ch || !ch.enabled || ch.unreadable) {
    cancel(rows.map((r) => r.id), !ch ? "Channel removed" : !ch.enabled ? "Channel turned off" : "Channel settings can't be read");
    return;
  }
  const t = now();
  const live: DeliveryRow[] = [];
  const subjects = new Map<number, string | null>();
  for (const r of rows) {
    if (r.event === "problem" && r.finding_id) {
      const f = getFinding(r.finding_id);
      const stale = !f || f.resolvedAt !== null || f.dismissedAt !== null || f.firstSeen !== r.episode;
      if (stale) continue; // followUps cancels it
      if (f.snoozedUntil && f.snoozedUntil > t) {
        cancel([r.id], "Snoozed before it was sent");
        run("UPDATE notify_deliveries SET followed_up = 1 WHERE id = ?", r.id);
        continue;
      }
      subjects.set(r.id, f.subject);
    }
    live.push(r);
  }

  // Oldest first; stop at the first failure and push the rest back with it (don't hammer a dead channel).
  const queue: { rows: DeliveryRow[]; msg: OutMessage }[] = [];
  for (const ev of ["problem", "resolved"] as const) {
    const of = live.filter((r) => r.event === ev);
    if (of.length >= BATCH_AT) {
      const b = batchMessage(of.map((r) => ({ title: r.title, severity: r.severity })), ev);
      queue.push({
        rows: of,
        msg: { title: b.title, body: b.body, link: b.link, linkLabel: b.linkLabel, level: ev === "resolved" ? "resolved" : b.severity === "fault" ? "fault" : "attention", event: ev, at: t, serverName: getSetting("serverName") },
      });
    } else for (const r of of) queue.push({ rows: [r], msg: outOf(r, subjects.get(r.id) ?? null) });
  }
  for (const r of live.filter((x) => x.event !== "problem" && x.event !== "resolved")) queue.push({ rows: [r], msg: outOf(r, null) });
  queue.sort((a, b) => a.rows[0]!.id - b.rows[0]!.id);

  for (let i = 0; i < queue.length; i++) {
    const ok = await attempt(ch, queue[i]!.rows, queue[i]!.msg);
    if (!ok) {
      const retryAt = one<{ n: number }>("SELECT next_attempt_at AS n FROM notify_deliveries WHERE id = ?", queue[i]!.rows[0]!.id)?.n ?? t + BACKOFF_MS[0]!;
      for (const rest of queue.slice(i + 1)) for (const r of rest.rows) run("UPDATE notify_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending'", retryAt, r.id);
      break;
    }
  }
}

async function sendDue() {
  const t = now();
  const rows = all<DeliveryRow>("SELECT * FROM notify_deliveries WHERE status = 'pending' AND not_before <= ? AND next_attempt_at <= ? ORDER BY id LIMIT 200", t, t);
  if (!rows.length) return;
  const groups = new Map<string, DeliveryRow[]>();
  for (const r of rows) {
    if (!r.channel_id) {
      cancel([r.id], "Channel removed");
      continue;
    }
    const arr = groups.get(r.channel_id) ?? [];
    arr.push(r);
    groups.set(r.channel_id, arr);
  }
  await Promise.all([...groups].map(([id, rs]) => sendGroup(id, rs).catch((e) => console.error("[gluon] notify: channel send failed", e))));
}

// ---------------------------------------------------------------- tick

let running = false;
let lastPrune = 0;
export async function tick() {
  if (running) return;
  running = true;
  try {
    await refreshAppNames();
    await fanOut();
    followUps();
    digests();
    await sendDue();
    if (now() - lastPrune > 3_600_000) {
      lastPrune = now();
      run("DELETE FROM notify_deliveries WHERE created_at < ? AND status != 'pending'", now() - RETENTION_MS);
    }
  } finally {
    running = false;
  }
}

let kickTimer: ReturnType<typeof setTimeout> | null = null;
/** Run a tick soon (debounced), e.g. right after a finding opens. */
export function kick(delayMs = 2000) {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void tick().catch((e) => console.error("[gluon] notify tick failed", e));
  }, delayMs);
  kickTimer.unref?.();
}

export { TICK_MS };
