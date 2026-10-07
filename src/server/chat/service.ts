import "server-only";
import crypto from "node:crypto";
import type { User } from "../auth/users";
import { audit } from "../audit";
import { AppError } from "../errors";
import { configRev } from "../caddy/routes";
import { currentConfig, saveRoutes } from "../network/routes-service";
import { withAppLock } from "../apps/lock";
import { componentChange } from "./settings";
import { chatSnapshot, prosodyFor, reloadProsody, restartProsody, writeSettings, type ProsodyTarget } from "./prosody";
import type { ChatSettings, ChatSnapshot } from "@/lib/chat-types";

export type Where = { ip: string; zone: string };

/** A password people can read off a screen and type on a phone: 4 groups of 4, no look-alikes. */
export function newPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export async function targetAndHost(appId: string, host: string): Promise<{ t: ProsodyTarget; snap: ChatSnapshot }> {
  const t = await prosodyFor(appId);
  const snap = await chatSnapshot(appId);
  if (!snap.hosts.some((h) => h.host === host)) throw new AppError("invalid", `${host} isn't a chat domain on this server.`, 400, { field: "host" });
  return { t, snap };
}

/** The chat server's web port as published on this server (container port 5280), if it is. */
function publishedWebPort(t: ProsodyTarget): number | null {
  const c = t.app.containers.find((x) => x.id === t.id);
  return c?.ports.find((p) => p.container === 5280 && p.proto === "tcp")?.host ?? null;
}

/** Point the chat domain's web address at the chat server's web port, for browser chat and uploads. */
async function ensureWebSide(user: User, where: Where, t: ProsodyTarget, host: string): Promise<string | null> {
  const cfg = currentConfig();
  const r = cfg.routes.find((x) => x.type === "subdomain" && x.host === host && !!x.xmpp);
  if (!r || r.type !== "subdomain" || !r.xmpp) return `There's no chat address for ${host} on Network yet, so browsers and uploads can't reach the chat server. Add it in Network.`;
  if (r.xmpp.http_port) return null;
  const port = publishedWebPort(t);
  if (!port) return `${t.app.name} doesn't publish its web port (5280), so Caddy can't send uploads to it. Publish 5280 in the app's compose file.`;
  const routes = cfg.routes.map((x) => (x.id === r.id && x.type === "subdomain" && x.xmpp ? { ...x, xmpp: { ...x.xmpp, http_port: port } } : x));
  await saveRoutes(user, where, { rev: configRev(cfg), routes, fallback: cfg.fallback });
  return null;
}

/** Settings that didn't take because the person's own config sets them (a VirtualHost value wins). */
function unapplied(asked: ChatSettings, got: ChatSettings): string[] {
  const out: string[] = [];
  if (asked.signUp !== got.signUp) out.push("who can make an account");
  if (asked.history !== "custom" && asked.history !== got.history) out.push("message history");
  if (asked.push !== got.push) out.push("notifications when the app is closed");
  if (asked.federation !== got.federation) out.push("chat with other servers");
  if (asked.web !== got.web) out.push("chat in a browser");
  if (asked.groups.on !== got.groups.on) out.push("group chats");
  if (asked.files.on !== got.files.on) out.push("photos and files");
  return out;
}

export async function applySettings(
  user: User,
  where: Where,
  appId: string,
  host: string,
  next: ChatSettings,
  restart: boolean,
  rev: string | null,
): Promise<{ restarted: boolean; notes: string[] }> {
  const t = await prosodyFor(appId);
  return withAppLock([appId], `Chat settings for ${t.app.name} are being saved`, async () => {
    // Read inside the lock and against what the person saw, so two tabs can't undo each other.
    const snap = await chatSnapshot(appId);
    if (rev && snap.config.rev !== rev) throw new AppError("stale", "The chat settings changed since this page loaded. Reload to see them, then make your change again.", 409);
    if (snap.major !== null && snap.major < 13) throw new AppError("prosody_old", `Gluon manages settings for Prosody 13 and newer, and this is ${snap.version}. Update Prosody first.`, 409);
    if (snap.hosts.length > 1) throw new AppError("several_domains", "This Prosody serves more than one chat domain, and Gluon's settings would apply to all of them. Change settings in Prosody's config file instead.", 409);
    const h = snap.hosts.find((x) => x.host === host);
    if (!h) throw new AppError("invalid", `${host} isn't a chat domain on this server.`, 400, { field: "host" });
    const needs = componentChange(h.settings, next, h.ownComponents);
    const online = snap.hosts.reduce((n, x) => n + x.accounts.reduce((m, a) => m + a.devices.length, 0), 0);
    if (needs.length && !restart) {
      throw new AppError("needs_restart", `Saving this restarts the chat server, for ${needs.join(" and ")}.`, 409, { online, changes: needs });
    }
    writeSettings(snap, h, next);
    const notes: string[] = [];
    if (next.web || next.files.on) {
      const why = await ensureWebSide(user, where, t, host);
      if (why) notes.push(why);
    }
    let restarted = false;
    if (needs.length) {
      await restartProsody(t);
      restarted = true;
    } else {
      const r = await reloadProsody(t);
      if (r.failed.length) notes.push(`Prosody couldn't turn on ${r.failed.map((f) => f.split(":")[0]).join(", ")}. Its log says why; restarting it may help.`);
    }
    // What Prosody now says, not what Gluon wrote: the person's own config can still win.
    const after = await chatSnapshot(appId)
      .then((x) => x.hosts.find((y) => y.host === host)?.settings ?? null)
      .catch(() => null);
    const missed = after && !restarted ? unapplied(next, after) : [];
    if (missed.length) notes.push(`Prosody's own config sets ${missed.join(", ")}, so those didn't change. Edit it under Prosody's config file below.`);
    audit(user, { action: "chat.settings", target: appId, summary: `Changed chat settings for ${host}${restarted ? " and restarted the chat server" : ""}`, detail: { host, settings: next, unapplied: missed } }, where);
    return { restarted, notes };
  });
}
