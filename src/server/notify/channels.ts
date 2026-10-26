import "server-only";
import { all, now, one, run, tx } from "../db";
import { decryptJson, encryptJson, id as newId } from "../crypto";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { findById, type User } from "../auth/users";
import { publicBaseUrl, getSetting } from "../settings";
import { MEMBER_CHANNEL_KINDS, normalizeFilter, subscriptionFilterSchema, type ChannelKind, type ChannelView, type EmailConfig, type TestResult, type XmppConfig } from "@/lib/alerts-types";
import { maskConfig, mergeConfig, summarize, validateConfig, type StoredConfig } from "./config";
import { assertReachableTarget, configHosts, deliver, DeliveryError, type OutMessage, type SendContext } from "./transports";

interface ChannelRow {
  id: string;
  owner: string | null;
  kind: ChannelKind;
  name: string;
  config_enc: string;
  enabled: number;
  created_at: number;
}

export interface Channel {
  id: string;
  owner: string | null;
  kind: ChannelKind;
  name: string;
  config: StoredConfig;
  /** The stored config couldn't be decrypted (secret.key changed). */
  unreadable: boolean;
  enabled: boolean;
  createdAt: number;
}

function toChannel(r: ChannelRow): Channel {
  let config: StoredConfig = {};
  let unreadable = false;
  try {
    config = decryptJson<StoredConfig>(r.config_enc);
  } catch {
    unreadable = true;
  }
  return { id: r.id, owner: r.owner, kind: r.kind, name: r.name, config, unreadable, enabled: !!r.enabled, createdAt: r.created_at };
}

export function getChannel(id: string): Channel | null {
  const r = one<ChannelRow>("SELECT * FROM channels WHERE id = ?", id);
  return r ? toChannel(r) : null;
}

export function allChannels(): Channel[] {
  return all<ChannelRow>("SELECT * FROM channels ORDER BY owner IS NOT NULL, name COLLATE NOCASE").map(toChannel);
}

/** Admins see every channel; members only their own. */
export function canSee(user: User, ch: { owner: string | null }) {
  return user.role === "admin" || ch.owner === user.id;
}

/** Admins can change any channel (members' ones too, e.g. to turn off a broken one); members their own. */
const canEdit = canSee;

// ---------------------------------------------------------------- send context

/** Hosts used by server-wide channels (admin-approved), which personal channels may also use. */
function adminHosts(): Set<string> {
  const out = new Set<string>();
  for (const c of allChannels()) {
    if (c.owner !== null || c.unreadable) continue;
    for (const h of configHosts(c.kind, c.config)) out.add(h);
  }
  return out;
}

function isRestricted(owner: string | null): boolean {
  if (!owner) return false;
  const u = findById(owner);
  return !u || u.role !== "admin";
}

function viaConfig(cfg: StoredConfig): EmailConfig | null {
  const via = (cfg as unknown as EmailConfig).via;
  if (!via) return null;
  const v = getChannel(via);
  if (!v || v.kind !== "email" || v.owner !== null || v.unreadable) return null;
  return v.config as unknown as EmailConfig;
}

export function sendContext(ch: Pick<Channel, "owner" | "kind" | "config">): SendContext {
  return {
    restricted: isRestricted(ch.owner),
    allowedHosts: adminHosts(),
    viaConfig: ch.kind === "email" ? viaConfig(ch.config) : null,
  };
}

// ---------------------------------------------------------------- views

interface HealthRow {
  last_sent: number | null;
  last_failed: number | null;
}

function health(id: string): ChannelView["health"] {
  const h = one<HealthRow>(
    `SELECT MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_sent,
            MAX(CASE WHEN last_error IS NOT NULL AND status IN ('failed', 'pending') THEN created_at END) AS last_failed
     FROM notify_deliveries WHERE channel_id = ?`,
    id,
  );
  const latest = one<{ status: string; last_error: string | null; attempts: number }>(
    "SELECT status, last_error, attempts FROM notify_deliveries WHERE channel_id = ? AND status != 'cancelled' AND (status != 'pending' OR attempts > 0) ORDER BY id DESC LIMIT 1",
    id,
  );
  const failing = !!latest && (latest.status === "failed" || (latest.status === "pending" && latest.attempts > 0));
  return { lastSentAt: h?.last_sent ?? null, lastFailedAt: h?.last_failed ?? null, lastError: failing ? latest!.last_error : null, failing };
}

function audience(id: string, viewer: User): ChannelView["audience"] {
  const rows = all<{ user_id: string; filter: string }>("SELECT s.user_id, s.filter FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.channel_id = ? AND u.disabled = 0", id);
  const own = rows.find((r) => r.user_id === viewer.id);
  let mine: ChannelView["audience"]["mine"] = null;
  if (own) {
    try {
      const p = subscriptionFilterSchema.safeParse(JSON.parse(own.filter));
      mine = p.success ? normalizeFilter(p.data).kinds : null;
    } catch {
      mine = null;
    }
  }
  return { people: rows.length, mine };
}

export function viewChannel(ch: Channel, viewer: User): ChannelView {
  const { config, secrets } = maskConfig(ch.kind, ch.config);
  const via = ch.kind === "email" && (ch.config as unknown as EmailConfig).via ? getChannel((ch.config as unknown as EmailConfig).via!) : null;
  const ownerRow = ch.owner ? findById(ch.owner) : null;
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    owner: ch.owner,
    ownerName: ownerRow?.display_name ?? null,
    enabled: ch.enabled,
    createdAt: ch.createdAt,
    config,
    secrets,
    summary: ch.unreadable ? "Settings can't be read (the secret key changed). Enter them again." : summarize(ch.kind, ch.config, via?.name),
    health: health(ch.id),
    editable: canEdit(viewer, ch),
    audience: audience(ch.id, viewer),
  };
}

export function listChannelsFor(user: User): ChannelView[] {
  return allChannels()
    .filter((c) => canSee(user, c))
    .map((c) => viewChannel(c, user));
}

// ---------------------------------------------------------------- mutations

async function checkConfig(user: User, owner: string | null, kind: ChannelKind, cfg: StoredConfig, selfId?: string) {
  if (owner && user.role !== "admin" && !MEMBER_CHANNEL_KINDS.includes(kind)) {
    throw forbidden("Household members can use ntfy, email, a webhook or this server's chat server for their own alerts.");
  }
  if (kind === "xmpp" && owner && isRestricted(owner) && (cfg as unknown as XmppConfig).mode !== "server") {
    throw new AppError("invalid", "Personal XMPP channels send through this server's chat server. Ask an admin to set up any other account.", 400, { field: "config.mode" });
  }
  if (kind === "email") {
    const via = (cfg as unknown as EmailConfig).via;
    if (via) {
      const v = getChannel(via);
      if (!v || v.kind !== "email" || v.owner !== null) throw new AppError("invalid", "Pick one of the server's email channels to send through.", 400, { field: "config.via" });
      if (via === selfId) throw new AppError("invalid", "A channel can't send through itself.", 400, { field: "config.via" });
      if ((v.config as unknown as EmailConfig).via) throw new AppError("invalid", "That channel sends through another one. Pick the one with the mail server details.", 400, { field: "config.via" });
    } else if (owner && isRestricted(owner) && !(cfg as unknown as EmailConfig).host) {
      throw new AppError("invalid", "Choose the server's mail setup to send through.", 400, { field: "config.via" });
    }
  }
  // Personal channels of members may not target the home network (see transports.assertReachableTarget).
  if (owner && isRestricted(owner)) {
    const ctx: SendContext = { restricted: true, allowedHosts: adminHosts() };
    const viaSet = kind === "email" && (cfg as unknown as EmailConfig).via;
    if (!viaSet) {
      for (const hk of configHosts(kind, cfg)) {
        const i = hk.lastIndexOf(":");
        try {
          await assertReachableTarget(hk.slice(0, i), Number(hk.slice(i + 1)), ctx);
        } catch (e) {
          if (e instanceof DeliveryError) throw new AppError("unsafe_target", e.message, 400);
          throw e;
        }
      }
    }
  }
}

export interface ChannelInput {
  kind: ChannelKind;
  name: string;
  scope: "server" | "personal";
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function createChannel(user: User, input: ChannelInput): Promise<Channel> {
  if (input.scope === "server" && user.role !== "admin") throw forbidden("Only admins can add server-wide channels.");
  if (user.role !== "admin" && !MEMBER_CHANNEL_KINDS.includes(input.kind)) {
    throw forbidden("Household members can use ntfy, email, a webhook or this server's chat server for their own alerts.");
  }
  const owner = input.scope === "server" ? null : user.id;
  const cfg = validateConfig(input.kind, mergeConfig(input.kind, null, input.config));
  await checkConfig(user, owner, input.kind, cfg);
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE owner IS ?", owner)?.n ?? 0;
  if (count >= 25) throw conflict("That's a lot of channels already. Remove one you don't use first.");
  const id = newId();
  run(
    "INSERT INTO channels (id, owner, kind, name, config_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    owner,
    input.kind,
    input.name.trim(),
    encryptJson(cfg),
    input.enabled ? 1 : 0,
    now(),
  );
  return getChannel(id)!;
}

export async function updateChannel(user: User, id: string, patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<Channel> {
  const ch = getChannel(id);
  if (!ch || !canSee(user, ch)) throw notFound("That channel");
  if (!canEdit(user, ch)) throw forbidden();
  let enc: string | null = null;
  if (patch.config) {
    const cfg = validateConfig(ch.kind, mergeConfig(ch.kind, ch.unreadable ? null : ch.config, patch.config));
    await checkConfig(user, ch.owner, ch.kind, cfg, ch.id);
    enc = encryptJson(cfg);
  }
  run(
    "UPDATE channels SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), config_enc = COALESCE(?, config_enc) WHERE id = ?",
    patch.name?.trim() || null,
    patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
    enc,
    id,
  );
  if (patch.enabled === false) {
    run("UPDATE notify_deliveries SET status = 'cancelled', last_error = 'Channel turned off' WHERE channel_id = ? AND status = 'pending'", id);
  }
  return getChannel(id)!;
}

export function deleteChannel(user: User, id: string): Channel {
  const ch = getChannel(id);
  if (!ch || !canSee(user, ch)) throw notFound("That channel");
  if (!canEdit(user, ch)) throw forbidden();
  const dependents = allChannels().filter((c) => c.kind === "email" && (c.config as unknown as EmailConfig).via === id);
  if (dependents.length) {
    throw conflict(
      `${dependents.length === 1 ? `“${dependents[0]!.name}” sends` : `${dependents.length} channels send`} email through this one. Point ${dependents.length === 1 ? "it" : "them"} at another mail server first.`,
    );
  }
  tx(() => {
    run("UPDATE notify_deliveries SET status = 'cancelled', last_error = 'Channel removed' WHERE channel_id = ? AND status = 'pending'", id);
    run("DELETE FROM channels WHERE id = ?", id);
  });
  return ch;
}

// ---------------------------------------------------------------- test send

export async function testChannel(
  user: User,
  input: { id?: string; kind?: ChannelKind; config?: Record<string, unknown>; scope?: "server" | "personal" },
): Promise<TestResult> {
  let kind: ChannelKind;
  let owner: string | null;
  let cfg: StoredConfig;
  let existing: Channel | null = null;
  if (input.id) {
    existing = getChannel(input.id);
    if (!existing || !canSee(user, existing)) throw notFound("That channel");
    kind = existing.kind;
    owner = existing.owner;
    cfg = input.config ? validateConfig(kind, mergeConfig(kind, existing.unreadable ? null : existing.config, input.config)) : existing.config;
    if (existing.unreadable && !input.config) throw new AppError("unreadable", "This channel's settings can't be read any more. Enter them again.", 409);
  } else {
    if (!input.kind || !input.config) throw new AppError("invalid", "Choose a kind of channel and fill it in first.", 400);
    kind = input.kind;
    owner = input.scope === "server" ? null : user.id;
    if (owner === null && user.role !== "admin") throw forbidden();
    cfg = validateConfig(kind, mergeConfig(kind, null, input.config));
  }
  await checkConfig(user, owner, kind, cfg, existing?.id);

  const serverName = getSetting("serverName");
  const m: OutMessage = {
    title: `Test from ${serverName}`,
    body: `If you can read this, ${existing ? `“${existing.name}”` : "this channel"} works. ${user.displayName} sent it from Gluon.`,
    link: `${publicBaseUrl()}/status`,
    linkLabel: "Open Gluon",
    level: "info",
    event: "test",
    at: now(),
    serverName,
  };
  const t0 = performance.now();
  try {
    await deliver(kind, cfg, m, sendContext({ owner, kind, config: cfg }));
    const where =
      kind === "email"
        ? "Check the inbox (and the spam folder)."
        : kind === "webhook"
          ? "Check the channel it posts to."
          : kind === "xmpp"
            ? "Check your chat app. Messages from a new contact may wait under requests."
            : "Check your phone.";
    return { ok: true, message: `Sent. ${where}`, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    const message = e instanceof DeliveryError ? e.message : `Sending failed: ${(e as Error).message}`;
    return { ok: false, message, latencyMs: Math.round(performance.now() - t0) };
  }
}
