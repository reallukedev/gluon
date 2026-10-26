import "server-only";
import { getApp, type AppSummary } from "../docker/apps";
import { AppError } from "../errors";
import { publicBaseUrl, getSetting } from "../settings";
import { tryReadConfig } from "../caddy/routes";
import { QUARK_IMAGE_RE } from "@/lib/service-kind";
import { execWithInput } from "./exec";
import { ctlValue, inviteFrom, parseCtl, quarkSnapshot, type QuarkInvite, type QuarkSettings, type QuarkSnapshot, type QuarkStatus } from "./quark-map";
import type { ChatInvite, ChatSnapshot } from "@/lib/chat-types";

/**
 * Quark, run by Gluon. Everything goes through `quark ctl` inside the container: one JSON request on
 * standard input, one JSON line back (see quark-map.ts). No port is opened and no secret shows up
 * in a process list. Quark applies every change live, so there is never a restart here.
 */

export interface QuarkTarget {
  app: AppSummary;
  id: string;
  name: string;
}

export async function quarkFor(appId: string): Promise<QuarkTarget> {
  const app = await getApp(appId);
  if (!app) throw new AppError("not_found", "That app doesn't exist (any more).", 404);
  const c = app.containers.find((x) => QUARK_IMAGE_RE.test(x.image));
  if (!c) throw new AppError("not_quark", `${app.name} doesn't run Quark.`, 400);
  if (c.state !== "running") throw new AppError("not_running", `${app.name} isn't running. Start it to manage chat accounts.`, 409);
  return { app, id: c.id, name: c.name };
}

/** One admin command. Quark's refusals come back as AppErrors with its own sentence. */
export async function quarkCtl<T>(t: { id: string }, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const r = await execWithInput(t.id, ["quark", "ctl"], JSON.stringify({ cmd, args }), { timeoutMs });
  if (r.timedOut) throw new AppError("quark_timeout", "Quark took too long to answer. It may be busy or stuck; try again, or restart it.", 504);
  return ctlValue<T>(parseCtl(r.stdout, r.stderr, r.exitCode));
}

export const quarkStatus = (t: QuarkTarget) => quarkCtl<QuarkStatus>(t, "status", {}, 8_000);

// ---------------------------------------------------------------- snapshot

function routeFor(hosts: string[]): { host: string; httpPort: number | null } | null {
  const cfg = tryReadConfig();
  const r = cfg?.routes.find((x) => x.type === "subdomain" && !!x.xmpp && hosts.includes(x.host));
  return r && r.type === "subdomain" ? { host: r.host, httpPort: r.xmpp?.http_port ?? null } : null;
}

const publicBase = () => (getSetting("publicHost").trim() ? publicBaseUrl() : null);

export async function quarkSnapshotOf(t: QuarkTarget): Promise<ChatSnapshot> {
  const raw = await quarkCtl<QuarkSnapshot>(t, "snapshot");
  const hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  return quarkSnapshot(raw, { app: { id: t.app.id, name: t.app.name }, container: t.name, route: routeFor(hosts.map((h) => h.host)), publicBase: publicBase() });
}

// ---------------------------------------------------------------- accounts

export const createQuarkAccount = (t: QuarkTarget, a: { host: string; user: string; password: string; role: "member" | "admin" }) => quarkCtl<true>(t, "account.create", a);

export function updateQuarkAccount(
  t: QuarkTarget,
  a: { host: string; user: string; password?: string; role?: "member" | "admin"; enabled?: boolean; signOut?: boolean | string },
): Promise<{ closed: number }> {
  const { signOut, ...rest } = a;
  // Quark takes true (every device) or one resource; false means "don't", so it's left out.
  return quarkCtl<{ closed: number }>(t, "account.update", { ...rest, ...(signOut ? { signOut } : {}) });
}

export const deleteQuarkAccount = (t: QuarkTarget, a: { host: string; user: string }) => quarkCtl<true>(t, "account.delete", a);

// ---------------------------------------------------------------- invites

export async function createQuarkInvite(t: QuarkTarget, a: { host: string; username: string | null; role: "member" | "admin"; days: number; reusable: boolean }): Promise<ChatInvite> {
  const raw = await quarkCtl<QuarkInvite>(t, "invite.create", { ...a, username: a.username || null });
  return inviteFrom(raw, a.host, publicBase());
}

export const revokeQuarkInvite = (t: QuarkTarget, a: { host: string; token: string }) => quarkCtl<true>(t, "invite.revoke", a);

/** For the public invite page: is this token a live account invite on that host? */
export const peekQuarkInvite = (t: QuarkTarget, a: { host: string; token: string }) => quarkCtl<{ expires: number; username: string | null; uri: string } | null>(t, "invite.peek", a, 8_000);

// ---------------------------------------------------------------- rooms

export const createQuarkRoom = (t: QuarkTarget, a: { service: string; room: string; name: string; description: string | null; public: boolean; membersOnly: boolean; owner: string | null }) =>
  quarkCtl<{ jid: string }>(t, "room.create", a);

export const destroyQuarkRoom = (t: QuarkTarget, a: { jid: string; reason: string | null }) => quarkCtl<true>(t, "room.destroy", a);

// ---------------------------------------------------------------- settings and config

export const quarkSettings = (t: QuarkTarget, host: string) => quarkCtl<QuarkSettings>(t, "settings.get", { host });

export const setQuarkSettings = (t: QuarkTarget, host: string, settings: QuarkSettings) => quarkCtl<{ applied: true; notes: string[] }>(t, "settings.set", { host, settings });

export const quarkConfig = (t: QuarkTarget) => quarkCtl<{ file: string; text: string }>(t, "config.get");

export const checkQuarkConfig = (t: QuarkTarget, text: string) => quarkCtl<{ ok: boolean; line: number | null; message: string }>(t, "config.check", { text }, 30_000);

/** Quark checks the text again, writes it atomically and reloads; a text that doesn't check is refused. */
export const saveQuarkConfig = (t: QuarkTarget, text: string) => quarkCtl<{ ok: true }>(t, "config.set", { text: text.endsWith("\n") ? text : `${text}\n` }, 30_000);

export const reloadQuark = (t: { id: string }) => quarkCtl<{ reloaded: true; certs: number }>(t, "reload", {}, 20_000);

// ---------------------------------------------------------------- messages

/** A server notification (Gluon's alerts), sent without signing in as a client. */
export const sendQuarkMessage = (t: QuarkTarget, m: { from: string; to: string; body: string; subject?: string }) => quarkCtl<true>(t, "message.send", m, 10_000);

// ---------------------------------------------------------------- for Network

const signUpCache = new Map<string, { at: number; value: boolean | null }>();

/** Whether strangers can make an account on `host`, asked of Quark. null when it can't be asked. Cached five minutes. */
export async function quarkOpenSignUp(appId: string, host: string): Promise<boolean | null> {
  const key = `${appId}:${host}`;
  const hit = signUpCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  let value: boolean | null = null;
  try {
    value = (await quarkSettings(await quarkFor(appId), host)).signUp === "open";
  } catch {
    value = null;
  }
  signUpCache.set(key, { at: Date.now(), value });
  return value;
}
