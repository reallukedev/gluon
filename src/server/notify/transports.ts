import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import nodemailer from "nodemailer";
import { isHomeIp, parseAddr } from "../net-zone";
import { NetError, safeFetch } from "../integrations/net";
import type { EmailConfig, NtfyConfig, PushoverConfig, WebhookConfig, ChannelKind } from "@/lib/alerts-types";
import type { StoredConfig } from "./config";

/**
 * The actual senders. Each either resolves (delivered) or throws DeliveryError whose message is a
 * sentence a person can act on ("ntfy answered 401: check the token"). No retries here; the
 * dispatcher owns retry and backoff.
 */

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Permanent errors (bad credentials, bad address) aren't worth retrying quickly. */
    public readonly permanent = false,
  ) {
    super(message);
  }
}

export type MessageLevel = "fault" | "attention" | "resolved" | "digest" | "info";

export interface OutMessage {
  title: string;
  body: string;
  link: string | null;
  linkLabel: string | null;
  level: MessageLevel;
  event: "problem" | "resolved" | "digest" | "report" | "test";
  findingId?: string | null;
  severity?: string | null;
  subject?: string | null;
  at: number;
  serverName: string;
}

export interface SendContext {
  /** Apply the "no addresses inside the home network" rule (personal channels of members). */
  restricted: boolean;
  /** host:port pairs admins already use for server-wide channels; restricted channels may use these. */
  allowedHosts: Set<string>;
  /** For email channels using another channel's mail server. */
  viaConfig?: EmailConfig | null;
}

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- address safety

function blocked(ip: string): boolean {
  // parseAddr also unwraps IPv4-mapped IPv6 in hex form (::ffff:7f00:1), which the URL parser produces.
  const a = parseAddr(ip);
  if (!a) return true; // not an address we understand: fail closed
  if (isHomeIp(a)) return true;
  if (net.isIPv4(a)) {
    const [o1] = a.split(".").map(Number);
    return o1 === 0 || (o1 !== undefined && o1 >= 224);
  }
  const l = a.toLowerCase();
  return l === "::" || l.startsWith("ff");
}

export const hostKey = (hostname: string, port: number | string) => `${hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`;

/**
 * Personal channels created by household members may not point inside the home network (otherwise
 * "test send" becomes a way to probe LAN services). Hosts an admin already uses for a server-wide
 * channel (e.g. a household ntfy server) are fine.
 */
export async function assertReachableTarget(hostname: string, port: number, ctx: SendContext): Promise<void> {
  if (!ctx.restricted) return;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (ctx.allowedHosts.has(hostKey(bare, port))) return;
  let addrs: string[];
  if (net.isIP(bare)) addrs = [bare];
  else {
    try {
      addrs = (await dns.lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new DeliveryError(`Couldn't find ${bare}. Check the address.`, true);
    }
  }
  if (addrs.some(blocked)) {
    throw new DeliveryError(
      `${bare} is inside the home network. Personal channels can only send to internet services; ask an admin to add this server as a notification channel first.`,
      true,
    );
  }
}

function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------- HTTP helpers

function describeNetError(e: unknown, host: string): DeliveryError {
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? err.code ?? "";
  if (err.name === "TimeoutError" || err.name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new DeliveryError(`${host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new DeliveryError(`Couldn't find ${host}. Check the address, and that the server can reach the internet.`, code === "ENOTFOUND");
  if (code === "ECONNREFUSED") return new DeliveryError(`${host} refused the connection. Is the service running on that port?`);
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return new DeliveryError(`${host} dropped the connection.`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new DeliveryError(`Can't reach ${host} from the server (no route).`);
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) {
    return new DeliveryError(`${host}'s certificate isn't trusted (${code}). Use its public https address, or a valid certificate.`, true);
  }
  if (/bad port/i.test(err.cause?.message ?? err.message ?? "")) return new DeliveryError(`Port ${host.split(":").pop()} is blocked for web requests. Use the service's usual port.`, true);
  return new DeliveryError(`Couldn't reach ${host}: ${err.cause?.message ?? err.message ?? "unknown error"}.`);
}

async function post(urlStr: string, init: { headers: Record<string, string>; body: string }, ctx: SendContext): Promise<{ status: number; text: string }> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new DeliveryError("That address isn't valid.", true);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new DeliveryError("Only http:// and https:// addresses work.", true);
  await assertReachableTarget(u.hostname, portOf(u), ctx);
  if (ctx.restricted && !ctx.allowedHosts.has(hostKey(u.hostname.replace(/^\[|\]$/g, ""), portOf(u)))) {
    // Personal channels: connect through the guarded fetcher, which checks the address it actually
    // connects to (a name can't resolve to an internet address for the check above and then to a
    // home address for the request). No redirects.
    try {
      const r = await safeFetch(u.toString(), {
        method: "POST",
        headers: { "User-Agent": "Gluon", ...init.headers },
        body: init.body,
        policy: "member",
        maxRedirects: 0,
        timeoutMs: TIMEOUT_MS,
        totalMs: TIMEOUT_MS + 5000,
        maxBytes: 64 * 1024,
      });
      return { status: r.status, text: r.body.toString("utf8").slice(0, 2000) };
    } catch (e) {
      if (e instanceof NetError) {
        if (e.code === "redirects") throw new DeliveryError(`${u.host} answered with a redirect. Use its final address instead.`, true);
        if (e.code === "blocked") throw new DeliveryError(`${u.hostname} is inside the home network. Personal channels can only send to internet services; ask an admin to add this server as a notification channel first.`, true);
        if (e.code === "timeout") throw new DeliveryError(`${u.host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
        if (e.code === "notfound") throw new DeliveryError(`Couldn't find ${u.hostname}. Check the address.`, true);
        if (e.code === "refused") throw new DeliveryError(`${u.host} refused the connection. Is the service running on that port?`);
        if (e.code === "tls") throw new DeliveryError(`${u.host}'s certificate isn't trusted. Use its public https address.`, true);
        throw new DeliveryError(`Couldn't reach ${u.host}.`);
      }
      throw e;
    }
  }
  let res: Response;
  try {
    res = await fetch(u, {
      method: "POST",
      headers: { "User-Agent": "Gluon", ...init.headers },
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw describeNetError(e, u.host);
  }
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    throw new DeliveryError(`${u.host} answered with a redirect${loc ? ` to ${loc.slice(0, 120)}` : ""}. Use that address instead.`, true);
  }
  return { status: res.status, text };
}

function jsonError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown; errors?: unknown };
    if (Array.isArray(j.errors) && j.errors.length) return j.errors.map(String).join("; ");
    if (typeof j.error === "string") return j.error;
    if (typeof j.message === "string") return j.message;
  } catch {
    /* not json */
  }
  const t = text.trim();
  return t && t.length < 200 && !t.startsWith("<") ? t : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- ntfy

const NTFY_TAGS: Record<MessageLevel, string[]> = {
  fault: ["rotating_light"],
  attention: ["warning"],
  resolved: ["white_check_mark"],
  digest: ["clipboard"],
  info: ["information_source"],
};

async function sendNtfy(c: NtfyConfig, m: OutMessage, ctx: SendContext) {
  const priority = m.level === "fault" ? c.priorities.fault : m.level === "attention" ? c.priorities.attention : m.level === "resolved" ? c.priorities.resolved : c.priorities.digest;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  else if (c.username && c.password) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`;
  const payload: Record<string, unknown> = {
    topic: c.topic,
    title: clip(m.title, 250),
    message: clip(m.body || m.title, 4000),
    priority,
    tags: NTFY_TAGS[m.level],
  };
  if (m.link) {
    payload.click = m.link;
    payload.actions = [{ action: "view", label: clip(m.linkLabel ?? "Open", 40), url: m.link, clear: true }];
  }
  const base = c.server.replace(/\/+$/, "");
  const { status, text } = await post(`${base}/`, { headers, body: JSON.stringify(payload) }, ctx);
  if (status >= 200 && status < 300) return;
  const why = jsonError(text);
  if (status === 401 || status === 403) {
    throw new DeliveryError(
      `ntfy answered ${status}: ${c.token ? "check the access token" : c.username ? "check the username and password" : "this topic needs a login; add an access token"}${why ? ` (${why})` : ""}.`,
      true,
    );
  }
  if (status === 404) throw new DeliveryError(`ntfy answered 404: check the server address${why ? ` (${why})` : ""}.`, true);
  if (status === 413) throw new DeliveryError("ntfy answered 413: the message was too large.", true);
  if (status === 429) throw new DeliveryError("ntfy answered 429: too many messages. It'll try again shortly.");
  throw new DeliveryError(`ntfy answered ${status}${why ? `: ${why}` : ""}.`);
}

// ---------------------------------------------------------------- Pushover

async function sendPushover(c: PushoverConfig, m: OutMessage, ctx: SendContext) {
  const priority = m.level === "fault" ? c.priorities.fault : m.level === "attention" ? c.priorities.attention : m.level === "resolved" ? c.priorities.resolved : c.priorities.digest;
  const form = new URLSearchParams({
    token: c.appToken ?? "",
    user: c.userKey ?? "",
    title: clip(m.title, 250),
    message: clip(m.body || m.title, 1024),
    priority: String(priority),
    timestamp: String(Math.floor(m.at / 1000)),
  });
  if (m.link) {
    form.set("url", clip(m.link, 512));
    form.set("url_title", clip(m.linkLabel ?? "Open", 100));
  }
  if (c.device) form.set("device", c.device);
  if (c.sound) form.set("sound", c.sound);
  const { status, text } = await post("https://api.pushover.net/1/messages.json", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, ctx);
  if (status >= 200 && status < 300) return;
  const why = jsonError(text);
  if (status === 429) throw new DeliveryError("Pushover answered 429: this app token is over its monthly message limit.", true);
  if (status >= 400 && status < 500) {
    const hint = /token/i.test(why ?? "") ? "check the application token" : /user|device/i.test(why ?? "") ? "check the user key and device name" : "check the keys";
    throw new DeliveryError(`Pushover answered ${status}: ${hint}${why ? ` (${why})` : ""}.`, true);
  }
  throw new DeliveryError(`Pushover answered ${status}${why ? `: ${why}` : ""}. It'll try again.`);
}

// ---------------------------------------------------------------- email

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function mailHtml(m: OutMessage): string {
  const body = esc(m.body).replace(/\n/g, "<br>");
  const link = m.link ? `<p style="margin:20px 0 0"><a href="${esc(m.link)}" style="color:#1a1a1a">${esc(m.linkLabel ?? "Open")}</a></p>` : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#f4f3ef">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #deddd6;padding:24px">
<h1 style="font-size:18px;margin:0 0 12px">${esc(m.title)}</h1><div>${body}</div>${link}
<p style="margin:24px 0 0;color:#6b6a63;font-size:12px">Sent by Gluon on ${esc(m.serverName)}. Change what you get in Settings → Notifications.</p>
</div></body></html>`;
}

function describeMailError(e: unknown, host: string): DeliveryError {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const resp = err.response ? ` (${clip(String(err.response).trim(), 160)})` : "";
  switch (err.code) {
    case "EAUTH":
      return new DeliveryError(`The mail server rejected the username or password${resp}. Many providers need an app password.`, true);
    case "EENVELOPE":
      return new DeliveryError(`The mail server refused the sender or recipient address${resp}.`, true);
    case "EDNS":
      return new DeliveryError(`Couldn't find ${host}. Check the mail server address.`, true);
    case "ETLS":
      return new DeliveryError(`Couldn't set up a secure connection with ${host}${resp}. Check the security setting (TLS on 465, STARTTLS on 587).`, true);
    case "ECONNECTION":
    case "ESOCKET":
      if (/certificate|self.signed/i.test(err.message ?? "")) return new DeliveryError(`${host}'s certificate isn't trusted. Turn on "allow self-signed" for a LAN relay.`, true);
      if (/ECONNREFUSED/.test(err.message ?? "")) return new DeliveryError(`${host} refused the connection. Check the port.`);
      if (/wrong version number|ssl3_get_record/i.test(err.message ?? "")) return new DeliveryError(`${host} doesn't speak TLS on that port. Try STARTTLS (usually port 587).`, true);
      return new DeliveryError(`Couldn't talk to ${host}: ${err.message ?? "connection failed"}.`);
    case "ETIMEDOUT":
      return new DeliveryError(`${host} didn't answer. Check the address and port (some networks block outgoing mail ports).`);
    default:
      if (err.responseCode && err.responseCode >= 500) return new DeliveryError(`The mail server refused the message${resp}.`, true);
      return new DeliveryError(`Sending mail failed: ${err.message ?? "unknown error"}${resp}.`);
  }
}

async function sendEmail(c: EmailConfig, m: OutMessage, ctx: SendContext) {
  const smtp = c.via ? ctx.viaConfig : c;
  if (!smtp || !smtp.host) throw new DeliveryError("The mail server this channel sends through was removed. Pick another one.", true);
  const port = smtp.port ?? (smtp.security === "tls" ? 465 : smtp.security === "starttls" ? 587 : 25);
  await assertReachableTarget(smtp.host, port, c.via ? { ...ctx, restricted: false } : ctx);
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? "" } : undefined,
    tls: { rejectUnauthorized: !smtp.allowSelfSigned },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const from = smtp.from || smtp.user!;
  const fromHeader = from.includes("<") ? from : `"Gluon (${m.serverName.replace(/"/g, "")})" <${from}>`;
  try {
    await transport.sendMail({
      from: fromHeader,
      to: c.to,
      subject: clip(m.title, 200),
      text: `${m.body}${m.link ? `\n\n${m.linkLabel ?? "Open"}: ${m.link}` : ""}\n\n— Gluon on ${m.serverName}`,
      html: mailHtml(m),
      headers: { "X-Gluon-Event": m.event, ...(m.findingId ? { "X-Gluon-Finding": m.findingId } : {}) },
    });
  } catch (e) {
    throw describeMailError(e, smtp.host);
  } finally {
    transport.close();
  }
}

// ---------------------------------------------------------------- webhooks

const DISCORD_COLOR: Record<MessageLevel, number> = { fault: 0xd23c2d, attention: 0xe8a33a, resolved: 0x3a9a5b, digest: 0x6b6a63, info: 0x6b6a63 };
const slackEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sendWebhook(c: WebhookConfig, m: OutMessage, ctx: SendContext) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: unknown;
  if (c.format === "discord") {
    body = {
      username: clip(`Gluon · ${m.serverName}`, 80),
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: clip(m.title, 256),
          description: clip(`${m.body}${m.link ? `\n\n[${m.linkLabel ?? "Open"}](${m.link})` : ""}`, 4000),
          url: m.link ?? undefined,
          color: DISCORD_COLOR[m.level],
          timestamp: new Date(m.at).toISOString(),
        },
      ],
    };
  } else if (c.format === "slack") {
    const link = m.link ? `\n<${m.link}|${slackEsc(m.linkLabel ?? "Open")}>` : "";
    body = { text: `*${slackEsc(m.title)}*\n${slackEsc(m.body)}${link}`, unfurl_links: false };
  } else {
    for (const h of c.headers) if (h.value) headers[h.name] = h.value;
    body = {
      event: m.event,
      level: m.level,
      title: m.title,
      body: m.body,
      link: m.link,
      finding: m.findingId ? { id: m.findingId, severity: m.severity ?? null, subject: m.subject ?? null } : null,
      server: m.serverName,
      at: new Date(m.at).toISOString(),
    };
  }
  const label = c.format === "discord" ? "Discord" : c.format === "slack" ? "Slack" : "The webhook";
  const { status, text } = await post(c.url ?? "", { headers, body: JSON.stringify(body) }, ctx);
  if (status >= 200 && status < 300) return;
  const why = jsonError(text);
  if (status === 401 || status === 403) throw new DeliveryError(`${label} answered ${status}: check the address${c.format === "json" ? " and headers" : ""}${why ? ` (${why})` : ""}.`, true);
  if (status === 404) throw new DeliveryError(`${label} answered 404: the webhook doesn't exist (any more)${why ? ` (${why})` : ""}.`, true);
  if (status === 429) throw new DeliveryError(`${label} answered 429: too many messages. It'll try again shortly.`);
  if (status >= 400 && status < 500) throw new DeliveryError(`${label} answered ${status}${why ? `: ${why}` : ""}.`, true);
  throw new DeliveryError(`${label} answered ${status}${why ? `: ${why}` : ""}.`);
}

// ---------------------------------------------------------------- entry point

export async function deliver(kind: ChannelKind, config: StoredConfig, m: OutMessage, ctx: SendContext): Promise<void> {
  switch (kind) {
    case "ntfy":
      return sendNtfy(config as unknown as NtfyConfig, m, ctx);
    case "pushover":
      return sendPushover(config as unknown as PushoverConfig, m, ctx);
    case "email":
      return sendEmail(config as unknown as EmailConfig, m, ctx);
    case "webhook":
      return sendWebhook(config as unknown as WebhookConfig, m, ctx);
  }
}

/** Where a config sends to, for the "hosts admins already use" allow-list. */
export function configHosts(kind: ChannelKind, c: StoredConfig): string[] {
  try {
    if (kind === "ntfy") {
      const u = new URL((c as unknown as NtfyConfig).server);
      return [hostKey(u.hostname, portOf(u))];
    }
    if (kind === "webhook") {
      const u = new URL((c as unknown as WebhookConfig).url ?? "");
      return [hostKey(u.hostname, portOf(u))];
    }
    if (kind === "email") {
      const e = c as unknown as EmailConfig;
      if (!e.host) return [];
      return [hostKey(e.host, e.port ?? (e.security === "tls" ? 465 : e.security === "starttls" ? 587 : 25))];
    }
  } catch {
    /* ignore */
  }
  return [];
}
