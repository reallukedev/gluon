import { z } from "zod";

/**
 * Notifications (channels, subscriptions, delivery log) and uptime monitors.
 * Shared by the server (validation) and the client (forms, views). No server imports.
 */

// ---------------------------------------------------------------- channels

export const CHANNEL_KINDS = ["ntfy", "pushover", "email", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Kinds a household member may create for their own alerts. */
export const MEMBER_CHANNEL_KINDS: ChannelKind[] = ["ntfy", "email", "webhook"];

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

export const channelConfigSchemas = {
  ntfy: ntfyConfigSchema,
  pushover: pushoverConfigSchema,
  email: emailConfigSchema,
  webhook: webhookConfigSchema,
} as const;

export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;
export type PushoverConfig = z.infer<typeof pushoverConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type ChannelConfig = NtfyConfig | PushoverConfig | EmailConfig | WebhookConfig;

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

export const subscriptionFilterSchema = z.object({
  /** Admins: which severities. Members always get "my app is down" (their filter ignores this). */
  severities: z.array(z.enum(["fault", "attention"])).max(2).default(["fault", "attention"]),
  /** "all", or a list of app ids / finding subjects. Members: limited to apps they can see. */
  subjects: z.union([z.literal("all"), z.array(z.string().min(1).max(200)).max(200)]).default("all"),
  /** Send a follow-up when the problem clears. */
  resolved: z.boolean().default(true),
  /** Admins: new problem reports from the household. Members: replies to their reports. */
  reports: z.boolean().default(true),
  /** Admins: the daily digest (Settings → digest sets the hour). */
  digest: z.boolean().default(false),
  quiet: quietHoursSchema.nullable().default(null),
  /** IANA time zone for quiet hours and the digest hour, e.g. "Europe/London". */
  tz: z.string().max(64).default("UTC"),
});
export type SubscriptionFilter = z.infer<typeof subscriptionFilterSchema>;

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

export type DeliveryEvent = "problem" | "resolved" | "digest" | "report";
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
