import { z } from "zod";

/**
 * Notifications (channels, subscriptions, delivery log) and uptime monitors.
 * Shared by the server (validation) and the client (forms, views). No server imports.
 */

// ---------------------------------------------------------------- channels

export const CHANNEL_KINDS = ["ntfy", "pushover", "email", "webhook", "xmpp"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Kinds a household member may create for their own alerts (XMPP only through this server's chat server). */
export const MEMBER_CHANNEL_KINDS: ChannelKind[] = ["ntfy", "email", "webhook", "xmpp"];

const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\/[^\s/]+/i.test(v), "Use a full address starting with https:// (or http://).");

/** ntfy priority 1 (min) … 5 (urgent). */
const ntfyPriority = z.number().int().min(1).max(5);
/** Pushover priority −2 (silent) … 1 (high). Emergency (2) needs acknowledgement, so it isn't offered. */
const pushoverPriority = z.number().int().min(-2).max(1);

/**
 * Secret fields: when updating, leave them out (or send back the masked value you were given) to keep
 * the stored secret; send `null` to clear an optional one.
 */
export const secretInput = z.string().max(2000).nullable().optional();

export const ntfyConfigSchema = z.object({
  server: url.default("https://ntfy.sh"),
  topic: z
    .string()
    .trim()
    .min(1, "Choose a topic.")
    .max(64)
    .regex(/^[-_A-Za-z0-9]+$/, "Topics use letters, numbers, dashes and underscores."),
  /** Access token (tk_…). Either this or username + password, or neither for open topics. */
  token: secretInput,
  username: z.string().trim().max(128).nullable().optional(),
  password: secretInput,
  priorities: z
    .object({ fault: ntfyPriority, attention: ntfyPriority, resolved: ntfyPriority, digest: ntfyPriority })
    .default({ fault: 5, attention: 3, resolved: 2, digest: 2 }),
});

export const pushoverConfigSchema = z.object({
  userKey: secretInput,
  appToken: secretInput,
  device: z.string().trim().max(64).nullable().optional(),
  sound: z.string().trim().max(32).nullable().optional(),
  priorities: z
    .object({ fault: pushoverPriority, attention: pushoverPriority, resolved: pushoverPriority, digest: pushoverPriority })
    .default({ fault: 1, attention: 0, resolved: -1, digest: -1 }),
});

export const emailConfigSchema = z.object({
  /**
   * Send through another (server-wide) email channel's mail server instead of entering SMTP details.
   * Household members use this: the admin sets up the mail server once.
   */
  via: z.string().max(64).nullable().optional(),
  host: z.string().trim().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  /** "tls" = implicit TLS (usually 465); "starttls" = upgrade (usually 587); "none" = plain (LAN relays only). */
  security: z.enum(["tls", "starttls", "none"]).default("starttls"),
  /** Accept self-signed certificates (LAN mail relays). */
  allowSelfSigned: z.boolean().default(false),
  user: z.string().trim().max(256).nullable().optional(),
  pass: secretInput,
  from: z.string().trim().max(256).nullable().optional(),
  to: z
    .array(z.string().trim().email("That doesn't look like an email address.").max(254))
    .min(1, "Add at least one address to send to.")
    .max(10),
});

export const WEBHOOK_FORMATS = ["json", "discord", "slack"] as const;
export const webhookConfigSchema = z.object({
  format: z.enum(WEBHOOK_FORMATS).default("json"),
  /** The URL is a secret for Discord/Slack (it embeds the token), so it is masked too. */
  url: secretInput,
  /** Extra headers for generic webhooks (e.g. Authorization). Values are secrets. */
  headers: z
    .array(z.object({ name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, "Header names use letters, numbers and dashes."), value: secretInput }))
    .max(8)
    .default([]),
});

/** user@domain or user@domain/resource; lowercased. Rooms are JIDs too (room@rooms.example.com). */
export const JID_RE = /^[^\s@/"&'<>:]{1,64}@[a-z0-9.-]{1,253}(?:\/\S{1,64})?$/i;
const jid = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(JID_RE, "Addresses look like name@chat.example.com.");

export const xmppConfigSchema = z.object({
  /**
   * "server": send through a chat server Gluon runs (Prosody), from gluon@<its domain>; no password.
   * "account": sign in to any XMPP account (JID + password) and send from it.
   */
  mode: z.enum(["server", "account"]).default("server"),
  /** server: the Gluon app running Prosody, and which of its domains sends. */
  app: z.string().trim().max(200).nullable().optional(),
  domain: z.string().trim().toLowerCase().max(253).nullable().optional(),
  /** account: the account that sends, its password (secret) and an optional server address (host or host:port). */
  jid: z.string().trim().toLowerCase().max(320).nullable().optional(),
  password: secretInput,
  server: z.string().trim().max(260).nullable().optional(),
  /** account: accept a certificate that isn't trusted (self-signed). Off unless someone turns it on for this channel. */
  allowUntrusted: z.boolean().default(false),
  /** People to message, one chat each. */
  to: z.array(jid).max(10).default([]),
  /** Group chats to post in. */
  rooms: z.array(jid).max(3).default([]),
  /** The name Gluon uses in group chats. */
  nick: z.string().trim().min(1).max(40).default("Gluon"),
});

export const channelConfigSchemas = {
  ntfy: ntfyConfigSchema,
  pushover: pushoverConfigSchema,
  email: emailConfigSchema,
  webhook: webhookConfigSchema,
  xmpp: xmppConfigSchema,
} as const;

export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;
export type PushoverConfig = z.infer<typeof pushoverConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type XmppConfig = z.infer<typeof xmppConfigSchema>;
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
  /** One line for lists: "ntfy.sh · leech-alerts", "2 addresses via Home mail". */
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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 22:30.");

export const quietHoursSchema = z.object({
  from: hhmm,
  to: hhmm,
  /** Faults still come through during quiet hours. */
  bypassFaults: z.boolean().default(true),
});

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

export const subscriptionFilterSchema = z.object({
  /**
   * What this subscription is told about. Filters saved before kinds existed don't have it; it is
   * worked out from the fields below so they keep doing exactly what they did (see normalizeFilter).
   */
  kinds: z.array(z.enum(NOTIFY_KINDS)).max(NOTIFY_KINDS.length).optional(),
  /** Kept in step with `kinds` for older readers: which problem severities. */
  severities: z.array(z.enum(["fault", "attention"])).max(2).default(["fault", "attention"]),
  /** "all", or a list of app ids / finding subjects. Members: limited to apps they can see. */
  subjects: z.union([z.literal("all"), z.array(z.string().min(1).max(200)).max(200)]).default("all"),
  /** Kept in step with `kinds`: send a follow-up when the problem clears. */
  resolved: z.boolean().default(true),
  /** Kept in step with `kinds`. Admins: new problem reports from the household. Members: replies to their reports. */
  reports: z.boolean().default(true),
  /** Kept in step with `kinds`. Admins: the daily digest (Settings → Server sets the hour). */
  digest: z.boolean().default(false),
  quiet: quietHoursSchema.nullable().default(null),
  /** IANA time zone for quiet hours and the digest hour, e.g. "Europe/London". */
  tz: z.string().max(64).default("UTC"),
});
type ParsedFilter = z.infer<typeof subscriptionFilterSchema>;
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

export const monitorConfigSchema = z.object({
  intervalSec: z.number().int().min(20).max(3600).default(60),
  timeoutSec: z.number().int().min(1).max(60).default(10),
  /** Consecutive failures before it counts as down. */
  failAfter: z.number().int().min(1).max(20).default(3),
  // http only
  method: z.enum(["GET", "HEAD"]).default("GET"),
  /** Inclusive status range that counts as up. */
  expectStatus: z
    .object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
    .refine((r) => r.min <= r.max, "The lowest status must be below the highest.")
    .default({ min: 200, max: 399 }),
  /** Text that must appear in the response (first 1 MB). */
  keyword: z.string().max(200).nullable().default(null),
  /** Up when the keyword is absent instead. */
  keywordAbsent: z.boolean().default(false),
  followRedirects: z.boolean().default(true),
  /** Accept self-signed/expired certificates (LAN apps). */
  ignoreTls: z.boolean().default(false),
  /** Severity when down. Auto monitors choose for you (public/household → fault). */
  severity: z.enum(["fault", "attention"]).default("attention"),
  /** App this monitor belongs to (links findings and lets household members be told). */
  app: z.string().max(200).nullable().default(null),
});
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;

export const monitorInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give it a name.").max(80),
    kind: z.enum(MONITOR_KINDS),
    /** http: full URL. tcp: host:port ([v6]:port for IPv6). */
    target: z.string().trim().min(1, "Enter what to check.").max(2000),
    config: monitorConfigSchema.partial().default({}),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "http" && !/^https?:\/\/[^\s/]+/i.test(v.target)) {
      ctx.addIssue({ code: "custom", path: ["target"], message: "Use a full address starting with http:// or https://." });
    }
    if (v.kind === "tcp" && !/^(\[[0-9a-f:.]+\]|[^\s:/[\]]+):\d{1,5}$/i.test(v.target)) {
      ctx.addIssue({ code: "custom", path: ["target"], message: "Use host:port, e.g. 192.168.1.20:22." });
    }
  });
export type MonitorInput = z.infer<typeof monitorInputSchema>;

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
