import "server-only";
import { all, run } from "../db";
import { AppError, forbidden, notFound } from "../errors";
import { listApps, appsForMember } from "../docker/apps";
import { getPrefs } from "../prefs";
import { getSetting } from "../settings";
import type { User } from "../auth/users";
import type { Finding } from "../findings";
import { subscriptionFilterSchema, type SubscriptionFilter, type SubscriptionsResponse } from "@/lib/alerts-types";
import { allChannels, getChannel, type Channel } from "./channels";

// ---------------------------------------------------------------- time zones & quiet hours

export function validTz(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of `ts` in `tz`. */
export function localParts(ts: number, tz: string): { date: string; hour: number; minute: number } {
  const zone = validTz(tz) ? tz : "UTC";
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is it quiet time now, and when does it end? A window like 22:00–07:00 crosses midnight. */
export function quietState(filter: Pick<SubscriptionFilter, "quiet" | "tz">, ts: number): { quiet: boolean; endsAt: number | null } {
  const q = filter.quiet;
  if (!q) return { quiet: false, endsAt: null };
  const from = toMin(q.from);
  const to = toMin(q.to);
  if (from === to) return { quiet: false, endsAt: null };
  const { hour, minute } = localParts(ts, filter.tz);
  const m = hour * 60 + minute;
  const quiet = from < to ? m >= from && m < to : m >= from || m < to;
  if (!quiet) return { quiet: false, endsAt: null };
  const delta = (to - m + 1440) % 1440;
  return { quiet: true, endsAt: ts - (ts % 60_000) + delta * 60_000 };
}

/** Best guess at someone's time zone: their preference, else the server's. */
export function defaultTz(userId: string): string {
  const pref = getPrefs(userId).timezone;
  if (pref && pref !== "auto" && validTz(pref)) return pref;
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return sys && validTz(sys) ? sys : "UTC";
}

// ---------------------------------------------------------------- storage

interface SubRow {
  user_id: string;
  channel_id: string;
  filter: string;
}

export function parseFilter(raw: string | null, userId: string): SubscriptionFilter {
  let obj: unknown = {};
  try {
    obj = raw ? JSON.parse(raw) : {};
  } catch {
    obj = {};
  }
  const parsed = subscriptionFilterSchema.safeParse(obj);
  const f = parsed.success ? parsed.data : subscriptionFilterSchema.parse({});
  if (!validTz(f.tz)) f.tz = defaultTz(userId);
  return f;
}

/** Channels this person may subscribe: their own, and (admins) the server-wide ones. */
export function subscribable(user: User, ch: Pick<Channel, "owner">): boolean {
  return ch.owner === user.id || (ch.owner === null && user.role === "admin");
}

async function subjectChoices(user: User): Promise<{ id: string; name: string }[]> {
  try {
    const apps = user.role === "admin" ? await listApps() : await appsForMember(user.id);
    return apps.filter((a) => !a.self).map((a) => ({ id: a.id, name: a.name }));
  } catch {
    return [];
  }
}

export async function listSubscriptions(user: User): Promise<SubscriptionsResponse> {
  const channels = allChannels().filter((c) => subscribable(user, c));
  const byId = new Map(channels.map((c) => [c.id, c]));
  const rows = all<SubRow>("SELECT * FROM subscriptions WHERE user_id = ?", user.id);
  const t = Date.now();
  return {
    subscriptions: rows
      .filter((r) => byId.has(r.channel_id))
      .map((r) => {
        const ch = byId.get(r.channel_id)!;
        const filter = parseFilter(r.filter, user.id);
        return { channelId: ch.id, channelName: ch.name, channelKind: ch.kind, filter, quietNow: quietState(filter, t).quiet };
      }),
    channels: channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, owner: c.owner, enabled: c.enabled })),
    subjects: await subjectChoices(user),
    role: user.role,
    digest: getSetting("digest"),
    mailSetups: allChannels()
      .filter((c) => c.owner === null && c.kind === "email" && c.enabled && !c.unreadable && !(c.config as { via?: string | null }).via)
      .map((c) => ({ id: c.id, name: c.name })),
  };
}

/** Clean a filter for this person: members only get "my apps" alerts and report replies. */
async function sanitize(user: User, input: Partial<SubscriptionFilter>): Promise<SubscriptionFilter> {
  const parsed = subscriptionFilterSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("invalid", issue?.message && !issue.message.startsWith("Invalid") ? issue.message : "Check the notification settings.", 400, {
      field: `filter.${issue?.path.join(".") ?? ""}`,
    });
  }
  const f = parsed.data;
  if (!validTz(f.tz)) throw new AppError("invalid", "That time zone isn't recognised.", 400, { field: "filter.tz" });
  if (user.role !== "admin") {
    f.severities = ["fault", "attention"];
    f.digest = false;
    if (f.subjects !== "all") {
      const visible = new Set((await appsForMember(user.id)).map((a) => a.id));
      const bad = f.subjects.filter((s) => !visible.has(s));
      if (bad.length) throw forbidden("You can only follow apps you can see.");
    }
  }
  if (f.severities.length === 0 && user.role === "admin" && !f.reports && !f.digest) {
    throw new AppError("invalid", "Pick at least one kind of alert, or remove this subscription.", 400, { field: "filter.severities" });
  }
  return f;
}

export async function setSubscription(user: User, channelId: string, input: Partial<SubscriptionFilter>): Promise<SubscriptionFilter> {
  const ch = getChannel(channelId);
  if (!ch) throw notFound("That channel");
  if (!subscribable(user, ch)) throw forbidden("You can't subscribe to that channel.");
  const f = await sanitize(user, { ...input, tz: input.tz || defaultTz(user.id) });
  run(
    "INSERT INTO subscriptions (user_id, channel_id, filter) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET filter = excluded.filter",
    user.id,
    channelId,
    JSON.stringify(f),
  );
  return f;
}

export function removeSubscription(user: User, channelId: string) {
  run("DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?", user.id, channelId);
}

// ---------------------------------------------------------------- dispatch helpers

export interface ActiveSub {
  userId: string;
  role: "admin" | "member";
  displayName: string;
  channel: Channel;
  filter: SubscriptionFilter;
}

/** Subscriptions whose person is enabled and whose channel is on (and still theirs to use). */
export function activeSubscriptions(): ActiveSub[] {
  const rows = all<SubRow & { role: "admin" | "member"; display_name: string }>(
    `SELECT s.*, u.role, u.display_name FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN channels c ON c.id = s.channel_id
     WHERE u.disabled = 0 AND c.enabled = 1`,
  );
  const channels = new Map(allChannels().map((c) => [c.id, c]));
  const out: ActiveSub[] = [];
  for (const r of rows) {
    const ch = channels.get(r.channel_id);
    if (!ch || ch.unreadable) continue;
    // A demoted admin keeps subscriptions to server-wide channels in the table; don't use them.
    if (ch.owner === null && r.role !== "admin") continue;
    if (ch.owner !== null && ch.owner !== r.user_id) continue;
    out.push({ userId: r.user_id, role: r.role, displayName: r.display_name, channel: ch, filter: parseFilter(r.filter, r.user_id) });
  }
  return out;
}

/** Finding kinds a household member may hear about (their apps being down, and back). */
export const MEMBER_KINDS = new Set(["app.broken", "monitor.down"]);
export const REPORT_KIND = "household.report";

/**
 * Does this subscription want this finding? `memberApps` = app ids the member can see (members only).
 */
export function wants(sub: ActiveSub, f: Pick<Finding, "kind" | "severity" | "subject">, memberApps: Set<string> | null): boolean {
  const flt = sub.filter;
  if (sub.role !== "admin") {
    if (!MEMBER_KINDS.has(f.kind) || !f.subject || !memberApps?.has(f.subject)) return false;
    return flt.subjects === "all" || flt.subjects.includes(f.subject);
  }
  if (f.kind === REPORT_KIND) return flt.reports;
  if (f.severity !== "fault" && f.severity !== "attention") return false;
  if (!flt.severities.includes(f.severity)) return false;
  if (flt.subjects === "all") return true;
  return !!f.subject && flt.subjects.includes(f.subject);
}
