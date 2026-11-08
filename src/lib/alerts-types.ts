import type { EmailConfig, MonitorConfig, MonitorInput, NtfyConfig, ParsedFilter, PushoverConfig, WebhookConfig, XmppConfig } from "./alerts-schemas";

export type { EmailConfig, MonitorConfig, MonitorInput, NtfyConfig, PushoverConfig, WebhookConfig, XmppConfig };

/**
 * Notifications (channels, subscriptions, delivery log) and uptime monitors.
 * Shared by the server and the client (forms, views). No server imports, and no zod: the schemas are in
 * alerts-schemas.ts so client bundles stay small.
 */

// ---------------------------------------------------------------- channels

export const CHANNEL_KINDS = ["ntfy", "pushover", "email", "webhook", "xmpp"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Kinds a household member may create for their own alerts (XMPP only through this server's chat server). */
export const MEMBER_CHANNEL_KINDS: ChannelKind[] = ["ntfy", "email", "webhook", "xmpp"];

export const WEBHOOK_FORMATS = ["json", "discord", "slack"] as const;
export const JID_RE = /^[^\s@/"&'<>:]{1,64}@[a-z0-9.-]{1,253}(?:\/\S{1,64})?$/i;

export type ChannelConfig = NtfyConfig | PushoverConfig | EmailConfig | WebhookConfig | XmppConfig;

/** Chat servers Gluon runs, for the XMPP channel form. */
export interface XmppServersResponse {
  servers: {
    app: string;
    name: string;
    running: boolean;
    /** Why it can't be read right now (stopped, console off…). */
    problem: string | null;
    domains: { domain: string; accounts: string[]; rooms: string[] }[];
  }[];
}

/** Placeholder the server puts in place of a stored secret. Sending it back keeps the secret. */
export const MASK = "••••";

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  name: string;
  /** null = server-wide (admins manage); otherwise the owner's user id. */
  owner: string | null;
  ownerName: string | null;
  enabled: boolean;
  createdAt: number;
  /** Config with secrets replaced by a masked hint (`••••a1b2`). */
  config: Record<string, unknown>;
  /** Which secret fields hold a value. */
  secrets: Record<string, boolean>;
  /** One line for lists: "ntfy.sh · homeserver-alerts", "2 addresses via Home mail". */
  summary: string;
  /** Delivery health from the log. */
  health: { lastSentAt: number | null; lastFailedAt: number | null; lastError: string | null; failing: boolean };
  /** Can the current viewer edit it? */
  editable: boolean;
  /** How many people it sends to, and what it sends the viewer (null: nothing). */
  audience: { people: number; mine: NotifyKind[] | null };
}

export interface TestResult {
  ok: boolean;
  /** Human sentence: "Sent. Check your phone." / "ntfy answered 401: check the token." */
  message: string;
  latencyMs: number;
}

// ---------------------------------------------------------------- subscriptions

/**
 * What a subscription can be told about. Problems come from findings; the rest are events Gluon
 * notices (updates, sign-ins, the chat server).
 */
export const NOTIFY_KINDS = [
  "fault",
  "attention",
  "resolved",
  "reports",
  "digest",
  "gluon.available",
  "gluon.installed",
  "gluon.failed",
  "app.available",
  "app.updated",
  "signin.new_device",
  "signin.locked",
  "mfa.off",
  "chat.joined",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type KindGroup = "problems" | "household" | "updates" | "security" | "chat";
export const KIND_GROUPS: { key: KindGroup; label: string }[] = [
  { key: "problems", label: "Problems" },
  { key: "household", label: "Summaries and reports" },
  { key: "updates", label: "Updates" },
  { key: "security", label: "Sign-ins and security" },
  { key: "chat", label: "Chat server" },
];

export interface KindInfo {
  key: NotifyKind;
  group: KindGroup;
  label: string;
  hint: string;
  /** "Only some apps" narrows it. */
  apps: boolean;
}

export const KIND_INFO: Record<NotifyKind, KindInfo> = {
  fault: { key: "fault", group: "problems", label: "Something broke", hint: "An app stopped, a disk is failing, a certificate expired.", apps: true },
  attention: { key: "attention", group: "problems", label: "Something needs you", hint: "Space running low, a mount that won't survive a restart, an app restarting a lot.", apps: true },
  resolved: { key: "resolved", group: "problems", label: "A problem cleared", hint: "A short follow-up after each problem message.", apps: true },
  reports: { key: "reports", group: "household", label: "Problem reports", hint: "Someone in the household reported a problem.", apps: false },
  digest: { key: "digest", group: "household", label: "Daily summary", hint: "Once a day: what's open, uptime and anything notable.", apps: false },
  "gluon.available": { key: "gluon.available", group: "updates", label: "A Gluon update is out", hint: "Once per version.", apps: false },
  "gluon.installed": { key: "gluon.installed", group: "updates", label: "Gluon updated", hint: "Including automatic updates.", apps: false },
  "gluon.failed": { key: "gluon.failed", group: "updates", label: "A Gluon update failed", hint: "Gluon keeps running the version it was on.", apps: false },
  "app.available": { key: "app.available", group: "updates", label: "An app has an update", hint: "From Umbrel's app store, or a newer image on Docker Hub or GitHub. Once per version.", apps: true },
  "app.updated": { key: "app.updated", group: "updates", label: "An app was updated", hint: "By Gluon, Umbrel or anything else that changed its image.", apps: true },
  "signin.new_device": { key: "signin.new_device", group: "security", label: "Sign-in from a new device", hint: "Someone signed in to Gluon from outside home on a device it hasn't seen.", apps: false },
  "signin.locked": { key: "signin.locked", group: "security", label: "Too many wrong passwords", hint: "Gluon started slowing down sign-ins to an account.", apps: false },
  "mfa.off": { key: "mfa.off", group: "security", label: "Two-step verification turned off", hint: "For any account.", apps: false },
  "chat.joined": { key: "chat.joined", group: "chat", label: "Someone joined the chat server", hint: "A new account appeared, usually from an invite link.", apps: false },
};

/** What household members can choose (always about apps they can see). */
export const MEMBER_KINDS: NotifyKind[] = ["fault", "attention", "resolved", "reports", "app.updated"];
export const MEMBER_KIND_INFO: Partial<Record<NotifyKind, { label: string; hint: string }>> = {
  resolved: { label: "When they're working again", hint: "A short message once it's fixed." },
  reports: { label: "Replies to my reports", hint: "When someone answers a problem you reported." },
  "app.updated": { label: "When my apps are updated", hint: "So you know why something looks different." },
};

/** "Problems only": everything that broke or needs someone, and when it clears. The default for new subscriptions. */
export const PROBLEM_KINDS: NotifyKind[] = ["fault", "attention", "resolved", "reports", "signin.new_device", "signin.locked", "mfa.off", "gluon.failed"];
export const MEMBER_DEFAULT_KINDS: NotifyKind[] = ["fault", "attention", "resolved", "reports"];

export const kindsFor = (role: "admin" | "member"): NotifyKind[] => (role === "admin" ? [...NOTIFY_KINDS] : MEMBER_KINDS);
export const defaultKinds = (role: "admin" | "member"): NotifyKind[] => (role === "admin" ? PROBLEM_KINDS : MEMBER_DEFAULT_KINDS);

export type SubscriptionFilter = Omit<ParsedFilter, "kinds"> & { kinds: NotifyKind[] };

/**
 * The kinds an old filter (no `kinds`) was getting. Sign-in alerts were "needs attention" problems
 * not about an app, so they came with attention, and only when every subject was chosen.
 */
export function kindsFromLegacy(f: Pick<ParsedFilter, "severities" | "subjects" | "resolved" | "reports" | "digest">): NotifyKind[] {
  const out: NotifyKind[] = [];
  if (f.severities.includes("fault")) out.push("fault");
  if (f.severities.includes("attention")) {
    out.push("attention");
    if (f.subjects === "all") out.push("signin.new_device", "signin.locked");
  }
  if (f.resolved) out.push("resolved");
  if (f.reports) out.push("reports");
  if (f.digest) out.push("digest");
  return out;
}

/** Fill in `kinds` (from the old fields when missing), keep it in catalog order, and bring the old fields in line with it. */
export function normalizeFilter(f: ParsedFilter): SubscriptionFilter {
  const chosen = new Set(f.kinds ?? kindsFromLegacy(f));
  const kinds = NOTIFY_KINDS.filter((k) => chosen.has(k));
  return {
    ...f,
    kinds,
    severities: (["fault", "attention"] as const).filter((s) => chosen.has(s)),
    resolved: chosen.has("resolved"),
    reports: chosen.has("reports"),
    digest: chosen.has("digest"),
  };
}

export type KindPreset = "all" | "problems" | "custom";
export function presetOf(kinds: NotifyKind[], role: "admin" | "member"): KindPreset {
  const set = new Set(kinds);
  const same = (list: NotifyKind[]) => list.length === set.size && list.every((k) => set.has(k));
  if (same(kindsFor(role))) return "all";
  if (same(defaultKinds(role))) return "problems";
  return "custom";
}

export interface SubscriptionView {
  channelId: string;
  channelName: string;
  channelKind: ChannelKind;
  filter: SubscriptionFilter;
  /** Is quiet time in effect right now? */
  quietNow: boolean;
}

export interface SubscriptionsResponse {
  subscriptions: SubscriptionView[];
  /** Channels the viewer may subscribe to (their own; admins also server-wide). */
  channels: { id: string; name: string; kind: ChannelKind; owner: string | null; enabled: boolean }[];
  /** App choices for the subjects picker (members: only apps they can see). */
  subjects: { id: string; name: string }[];
  role: "admin" | "member";
  digest: { enabled: boolean; hour: number };
  /** Server-wide email channels a personal email channel can send through (`config.via`). */
  mailSetups: { id: string; name: string }[];
}

// ---------------------------------------------------------------- delivery log

export const DELIVERY_EVENTS = ["problem", "resolved", "digest", "report", "update", "security", "chat"] as const;
/** problem/resolved come from findings; update, security and chat are events Gluon noticed (see NotifyKind). */
export type DeliveryEvent = (typeof DELIVERY_EVENTS)[number];
export type DeliveryStatus = "pending" | "sent" | "failed" | "cancelled";

export interface DeliveryEntry {
  id: number;
  createdAt: number;
  channelId: string | null;
  channelName: string;
  channelKind: ChannelKind | null;
  userId: string | null;
  event: DeliveryEvent;
  findingId: string | null;
  severity: "fault" | "attention" | "info" | null;
  title: string;
  body: string;
  link: string | null;
  status: DeliveryStatus;
  /** Waiting for quiet hours to end (pending only). */
  notBefore: number;
  nextAttemptAt: number;
  attempts: number;
  lastError: string | null;
  sentAt: number | null;
}

export interface DeliveryPage {
  items: DeliveryEntry[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
}

// ---------------------------------------------------------------- monitors

export const MONITOR_KINDS = ["http", "tcp"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

export type MonitorState = "up" | "down" | "failing" | "pending" | "paused" | "idle";

/** One hour of history. `ratio` is the share of checks that passed (null = no checks). */
export interface StripBucket {
  start: number;
  checks: number;
  ok: number;
  ratio: number | null;
  state: "up" | "partial" | "down" | "none";
  avgMs: number | null;
}

export interface MonitorView {
  id: string;
  name: string;
  kind: MonitorKind;
  target: string;
  source: "user" | "auto";
  /** Auto monitors: "route:<id>" or "app:<id>". */
  ref: string | null;
  enabled: boolean;
  config: MonitorConfig;
  createdAt: number;
  /**
   * up · down (failAfter reached, finding open) · failing (failed, not yet down) · pending (no checks yet) ·
   * paused (turned off) · idle (auto monitor whose app is stopped on purpose, so it isn't checked).
   */
  state: MonitorState;
  since: number | null;
  last: { at: number; ok: boolean; latencyMs: number | null; status: number | null; error: string | null } | null;
  consecutiveFailures: number;
  flapping: boolean;
  uptime: { h24: number | null; d7: number | null; d30: number | null; d90: number | null };
  latency: { p50: number | null; p95: number | null; p99: number | null };
  /** Last 48 hours, oldest first. */
  strip: StripBucket[];
  findingId: string | null;
}

export interface MonitorCheck {
  at: number;
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
}

export interface MonitorDetail extends MonitorView {
  checks: MonitorCheck[];
  /** Outages (runs of failures) in the retained history, newest first. */
  incidents: { start: number; end: number | null; checks: number; error: string | null }[];
  /** Hourly strip for the last 7 days (168 buckets). */
  week: StripBucket[];
}

export interface CheckNowResult extends MonitorCheck {
  message: string;
}
