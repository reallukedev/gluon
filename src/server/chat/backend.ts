import "server-only";
import { getApp, listApps, type AppSummary } from "../docker/apps";
import { AppError } from "../errors";
import { chatServerOf } from "@/lib/service-kind";
import * as prosody from "./prosody";
import * as quark from "./quark";
import type { ChatConfigView, ChatInvite, ChatServerKind, ChatSnapshot } from "@/lib/chat-types";

/**
 * One way in for every chat screen and route, whichever server the app runs. The app's container
 * image picks the backend: Prosody (Lua through prosodyctl's console) or Quark (JSON through
 * `quark ctl`). Both answer in Gluon's own shapes, so callers only branch where the servers
 * really differ (restarts, config files, the call relay).
 */

export type ChatTarget = (prosody.ProsodyTarget & { kind: "prosody" }) | (quark.QuarkTarget & { kind: "quark" });

/** Which chat server an app runs, from its containers, without needing it to be running. */
export function chatKindOfApp(app: Pick<AppSummary, "containers">): ChatServerKind | null {
  // Quark first, the same order as serviceKind(), so the tab and the API agree.
  if (app.containers.some((c) => chatServerOf(c.image) === "quark")) return "quark";
  if (app.containers.some((c) => chatServerOf(c.image) === "prosody")) return "prosody";
  return null;
}

export async function chatTarget(appId: string): Promise<ChatTarget> {
  const app = await getApp(appId);
  if (!app) throw new AppError("not_found", "That app doesn't exist (any more).", 404);
  const kind = chatKindOfApp(app);
  if (kind === "quark") return { ...(await quark.quarkFor(appId)), kind: "quark" };
  if (kind === "prosody") return { ...(await prosody.prosodyFor(appId)), kind: "prosody" };
  throw new AppError("not_chat", `${app.name} doesn't run a chat server Gluon manages (Prosody or Quark).`, 400);
}

/** "Prosody" or "Quark", for sentences. */
export const serverName = (k: ChatServerKind) => (k === "quark" ? "Quark" : "Prosody");

/** Apps that run a chat server Gluon manages, with which one. */
export async function chatApps(opts: { running?: boolean } = {}): Promise<{ app: AppSummary; kind: ChatServerKind; running: boolean }[]> {
  const apps = await listApps().catch(() => []);
  const out: { app: AppSummary; kind: ChatServerKind; running: boolean }[] = [];
  for (const app of apps) {
    const kind = chatKindOfApp(app);
    if (!kind) continue;
    const running = app.containers.some((c) => chatServerOf(c.image) === kind && c.state === "running");
    if (opts.running && !running) continue;
    out.push({ app, kind, running });
  }
  return out;
}

// ---------------------------------------------------------------- reading

export async function chatSnapshot(appId: string): Promise<ChatSnapshot> {
  const t = await chatTarget(appId);
  return t.kind === "quark" ? quark.quarkSnapshotOf(t) : prosody.chatSnapshot(appId);
}

// ---------------------------------------------------------------- accounts, invites, rooms

export const USERNAME_RE = prosody.USERNAME_RE;

export function createAccount(t: ChatTarget, a: { host: string; user: string; password: string; role: "member" | "admin" }): Promise<true> {
  return t.kind === "quark" ? quark.createQuarkAccount(t, a) : prosody.createAccount(t, a);
}

export function updateAccount(t: ChatTarget, a: { host: string; user: string; password?: string; role?: "member" | "admin"; enabled?: boolean; signOut?: boolean | string }): Promise<{ closed: number }> {
  return t.kind === "quark" ? quark.updateQuarkAccount(t, a) : prosody.updateAccount(t, a);
}

export function deleteAccount(t: ChatTarget, a: { host: string; user: string }): Promise<true> {
  return t.kind === "quark" ? quark.deleteQuarkAccount(t, a) : prosody.deleteAccount(t, a);
}

/** Taken already: Prosody says so in words, Quark with its `exists` code. */
export const isAccountExists = (e: unknown) => (e instanceof AppError && e.code === "exists") || /already an account/i.test((e as Error)?.message ?? "");

export function createInvite(t: ChatTarget, a: { host: string; username: string | null; role: "member" | "admin"; days: number; reusable: boolean }): Promise<ChatInvite> {
  return t.kind === "quark" ? quark.createQuarkInvite(t, a) : prosody.createInvite(t, a);
}

export function revokeInvite(t: ChatTarget, a: { host: string; token: string }): Promise<true> {
  return t.kind === "quark" ? quark.revokeQuarkInvite(t, a) : prosody.revokeInvite(t, a);
}

export function peekInvite(t: ChatTarget, a: { host: string; token: string }): Promise<{ expires: number; username: string | null; uri: string } | null> {
  return t.kind === "quark" ? quark.peekQuarkInvite(t, a) : prosody.peekChatInvite(t, a);
}

export function createRoom(t: ChatTarget, a: { service: string; room: string; name: string; description: string | null; public: boolean; membersOnly: boolean; owner: string | null }): Promise<{ jid: string }> {
  return t.kind === "quark" ? quark.createQuarkRoom(t, a) : prosody.createRoom(t, a);
}

export function destroyRoom(t: ChatTarget, a: { jid: string; reason: string | null }): Promise<true> {
  return t.kind === "quark" ? quark.destroyQuarkRoom(t, a) : prosody.destroyRoom(t, a);
}

// ---------------------------------------------------------------- config file

export type ConfigCheck = { ok: boolean; line: number | null; message: string; output: string };

export async function readChatConfig(appId: string): Promise<ChatConfigView> {
  const t = await chatTarget(appId);
  if (t.kind === "quark") {
    const f = await quark.quarkConfig(t);
    return { server: "quark", language: "toml", main: f.text, gluon: null, file: f.file, writable: true, reason: null, canRestart: false };
  }
  const f = await prosody.readConfigFiles(appId);
  return { server: "prosody", language: "lua", main: f.main, gluon: f.gluon, file: f.file, writable: f.snap.config.writable, reason: f.snap.config.reason, canRestart: true };
}

export async function checkChatConfig(appId: string, text: string): Promise<ConfigCheck> {
  const t = await chatTarget(appId);
  if (t.kind === "quark") {
    const r = await quark.checkQuarkConfig(t, text);
    return { ok: !!r.ok, line: r.line ?? null, message: r.message || (r.ok ? "Quark can read this config." : "Quark found a problem in the config."), output: "" };
  }
  const f = await prosody.readConfigFiles(appId);
  return prosody.checkConfigText(t, f.snap, text);
}

/**
 * Check and save the config, refusing a save from a page that loaded an older file. Prosody then
 * reloads (or restarts, for new hosts and ports); Quark reloads it on its own. Call inside the app's lock.
 */
export async function saveChatConfig(t: ChatTarget, appId: string, a: { text: string; base: string; restart: boolean }): Promise<{ saved: boolean; check: ConfigCheck; restarted: boolean }> {
  if (t.kind === "quark") {
    const cur = await quark.quarkConfig(t);
    if (cur.text !== a.base) throw new AppError("stale", "Quark's config changed since you opened it. Reload it, then make your change again.", 409);
    const check = await checkChatConfig(appId, a.text);
    if (!check.ok) return { saved: false, check, restarted: false };
    await quark.saveQuarkConfig(t, a.text);
    return { saved: true, check, restarted: false };
  }
  const f = await prosody.readConfigFiles(appId);
  if (f.main !== a.base) throw new AppError("stale", "Prosody's config changed since you opened it. Reload it, then make your change again.", 409);
  const check = await prosody.checkConfigText(t, f.snap, a.text);
  if (!check.ok) return { saved: false, check, restarted: false };
  await prosody.saveMainConfig(t, f.snap, a.text);
  if (a.restart) await prosody.restartProsody(t);
  else await prosody.reloadProsody(t);
  return { saved: true, check, restarted: a.restart };
}

// ---------------------------------------------------------------- for Network

/** Whether strangers can really make an account on `host`. null when it isn't a chat server Gluon can ask. */
export async function openSignUp(appId: string | undefined, host: string): Promise<boolean | null> {
  if (!appId) return null;
  const app = await getApp(appId).catch(() => null);
  if (app && chatKindOfApp(app) === "quark") return quark.quarkOpenSignUp(appId, host);
  return prosody.openSignUp(appId, host);
}
