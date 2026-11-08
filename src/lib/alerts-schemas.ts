import "server-only";
import { z } from "zod";
import { JID_RE, MONITOR_KINDS, NOTIFY_KINDS, WEBHOOK_FORMATS } from "./alerts-types";

const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\/[^\s/]+/i.test(v), "Use a full address starting with https:// (or http://).");

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
  /** Send through a server-wide email channel's mail server, so household members needn't enter SMTP details. */
  via: z.string().max(64).nullable().optional(),
  host: z.string().trim().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  /** "tls" = implicit TLS (usually 465); "starttls" = upgrade (usually 587); "none" = plain (LAN relays only). */
  security: z.enum(["tls", "starttls", "none"]).default("starttls"),
  allowSelfSigned: z.boolean().default(false),
  user: z.string().trim().max(256).nullable().optional(),
  pass: secretInput,
  from: z.string().trim().max(256).nullable().optional(),
  to: z
    .array(z.string().trim().email("That doesn't look like an email address.").max(254))
    .min(1, "Add at least one address to send to.")
    .max(10),
});

export const webhookConfigSchema = z.object({
  format: z.enum(WEBHOOK_FORMATS).default("json"),
  /** The URL is a secret for Discord/Slack (it embeds the token), so it is masked too. */
  url: secretInput,
  /** Extra headers for generic webhooks. Values are secrets. */
  headers: z
    .array(z.object({ name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, "Header names use letters, numbers and dashes."), value: secretInput }))
    .max(8)
    .default([]),
});

/** user@domain or user@domain/resource; lowercased. Rooms are JIDs too (room@rooms.example.com). */
const jid = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(JID_RE, "Addresses look like name@chat.example.com.");

export const xmppConfigSchema = z.object({
  /**
   * "server": send through a chat server Gluon runs (Prosody or Quark), from gluon@<its domain>; no password.
   * "account": sign in to any XMPP account (JID + password) and send from it.
   */
  mode: z.enum(["server", "account"]).default("server"),
  /** server: the Gluon app running Prosody or Quark, and which of its domains sends. */
  app: z.string().trim().max(200).nullable().optional(),
  domain: z.string().trim().toLowerCase().max(253).nullable().optional(),
  /** account: the account that sends, its password (secret) and an optional server address (host or host:port). */
  jid: z.string().trim().toLowerCase().max(320).nullable().optional(),
  password: secretInput,
  server: z.string().trim().max(260).nullable().optional(),
  /** account: accept a self-signed certificate. */
  allowUntrusted: z.boolean().default(false),
  to: z.array(jid).max(10).default([]),
  rooms: z.array(jid).max(3).default([]),
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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 22:30.");

export const quietHoursSchema = z.object({
  from: hhmm,
  to: hhmm,
  /** Faults still come through during quiet hours. */
  bypassFaults: z.boolean().default(true),
});

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
  tz: z.string().max(64).default("UTC"),
});
export type ParsedFilter = z.infer<typeof subscriptionFilterSchema>;

export const monitorConfigSchema = z.object({
  intervalSec: z.number().int().min(20).max(3600).default(60),
  timeoutSec: z.number().int().min(1).max(60).default(10),
  failAfter: z.number().int().min(1).max(20).default(3),
  // http only
  method: z.enum(["GET", "HEAD"]).default("GET"),
  expectStatus: z
    .object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
    .refine((r) => r.min <= r.max, "The lowest status must be below the highest.")
    .default({ min: 200, max: 399 }),
  /** Text that must appear in the response (first 1 MB). */
  keyword: z.string().max(200).nullable().default(null),
  keywordAbsent: z.boolean().default(false),
  followRedirects: z.boolean().default(true),
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
