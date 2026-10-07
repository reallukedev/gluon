import "server-only";
import path from "node:path";
import { appsRoot } from "../apps/root";
import { hostExists } from "../host/paths";
import type { User } from "../auth/users";
import { audit } from "../audit";
import { AppError } from "../errors";
import { appDetail, createDraft } from "../appstore/service";
import { serverChecks } from "../appstore/checks";
import { configRev, PROSODY_CERT_DIR, tryReadConfig, XMPP_C2S_PORT, XMPP_S2S_PORT } from "../caddy/routes";
import { currentConfig, saveRoutes } from "../network/routes-service";
import { chatSnapshot, createAccount, prosodyFor, updateAccount, writeConfd } from "./prosody";
import { docker } from "../docker/client";
import { getApp, invalidateApps, listApps } from "../docker/apps";
import { getSetting, publicBaseUrl } from "../settings";
import { newPassword, type Where } from "./service";
import { DOMAIN_RE, installSettings, prosodyRecipe, type ChatInstall } from "./recipe";
import type { ChatSettings } from "@/lib/chat-types";

/** What the install flow needs to know first: chat servers already here and ports in use. */
export async function installPlan(domain: string | null) {
  const apps = await listApps().catch(() => []);
  const existing = apps.filter((a) => a.containers.some((c) => /prosody/i.test(c.image))).map((a) => ({ id: a.id, name: a.name }));
  const spec = prosodyRecipe({ domain: domain && DOMAIN_RE.test(domain) ? domain : "chat.example.com", username: "admin", settings: installSettings("chat.example.com") });
  const check = await serverChecks(spec, "compose", null).catch(() => null);
  const conflicts = (check?.issues ?? []).filter((i) => i.level === "error" && /already used/.test(i.message)).map((i) => i.message);
  const cfg = tryReadConfig();
  return {
    existing,
    conflicts,
    baseDomain: cfg?.base_domain ?? null,
    network: !!cfg,
    taken: cfg?.routes.flatMap((r) => (r.type === "subdomain" ? [r.host] : [])) ?? [],
  };
}

/** An app id no compose project or folder in the apps folder uses yet: prosody, chat-server, prosody-2… */
async function freeSlug(): Promise<string> {
  const ids = new Set((await listApps().catch(() => [])).map((x) => x.id));
  const root = await appsRoot().catch(() => null);
  const free = (slug: string) => !ids.has(slug) && !(root && hostExists(path.posix.join(root, slug)));
  for (const slug of ["prosody", "chat-server", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `prosody-${n}`)]) if (free(slug)) return slug;
  throw new AppError("no_name", "Gluon couldn't find a free name for the chat server app.", 409);
}

export async function startChatInstall(user: User, where: Where, a: ChatInstall): Promise<string> {
  if (!DOMAIN_RE.test(a.domain)) throw new AppError("invalid", "Enter a domain like chat.example.com.", 400, { field: "domain" });
  const plan = await installPlan(a.domain);
  if (plan.conflicts.length) throw new AppError("ports_taken", `${plan.conflicts[0]} A chat server needs ports 5222, 5269 and 5280.`, 409);
  const spec = prosodyRecipe(a);
  return createDraft(user, where, { source: "compose", spec: { ...spec, details: { ...spec.details, slug: await freeSlug() } } });
}

async function until<T>(what: string, fn: () => Promise<T>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new AppError("install_timeout", `${what} didn't happen within a minute${last instanceof Error ? ` (${last.message})` : ""}.`, 504);
}

/**
 * After the builder started the app: write Gluon's settings, make the first account, and publish
 * the chat domain on Network so Caddy gets its certificate (which Gluon then copies in).
 */
export async function finishChatInstall(user: User, where: Where, draftId: string, a: ChatInstall): Promise<{ appId: string; jid: string; password: string; routeAdded: boolean; notes: string[] }> {
  const d = await appDetail(draftId);
  const appId = d.appId;
  if (!appId || d.status !== "published") throw new AppError("not_ready", "The chat server isn't installed yet. Wait for the install to finish.", 409);
  const notes: string[] = [];

  // Settings first, straight into the app's conf.d, then one restart picks them up. A retry
  // rewrites them, so a bad file from an earlier attempt can't keep Prosody down.
  const app = await getApp(appId);
  const container = app?.containers.find((c) => /prosody/i.test(c.image));
  if (!app?.workingDir || !container) throw new AppError("not_ready", "Gluon can't find the chat server's folder.", 409);
  const settings: ChatSettings = { ...a.settings, contact: a.settings.contact ?? `${a.username}@${a.domain}` };
  writeConfd(path.posix.join(app.workingDir, "data", "conf.d"), settings, { host: a.domain, publicBase: getSetting("publicHost").trim() ? publicBaseUrl() : null });
  await docker().getContainer(container.id).restart({ t: 10 });
  invalidateApps();
  const t2 = await until("Prosody starting", async () => {
    const x = await prosodyFor(appId);
    const s = await chatSnapshot(appId);
    if (!s.hosts.some((h) => h.host === a.domain)) throw new Error(`no ${a.domain} yet`);
    return x;
  });

  // Safe to run again after a failed attempt: an account made last time gets a fresh password.
  const password = newPassword();
  try {
    await createAccount(t2, { host: a.domain, user: a.username, password, role: "admin" });
  } catch (e) {
    if (!/already an account/i.test((e as Error).message)) throw e;
    await updateAccount(t2, { host: a.domain, user: a.username, password, signOut: true });
  }

  let routeAdded = false;
  const cfg = tryReadConfig();
  if (!cfg) notes.push("Gluon isn't connected to a Caddy setup, so add the chat domain's DNS and certificate yourself.");
  else if (cfg.routes.some((r) => r.type === "subdomain" && r.host === a.domain && !!r.xmpp && r.app === appId)) routeAdded = true;
  else if (cfg.routes.some((r) => r.type === "subdomain" && r.host === a.domain)) notes.push(`${a.domain} already has an address on Network, so Gluon left it as it is. Make sure it's set up as a chat server there.`);
  else {
    const current = currentConfig();
    const route = {
      id: `chat-${Math.random().toString(16).slice(2, 6)}`,
      type: "subdomain" as const,
      name: "Chat",
      enabled: true,
      app: appId,
      host: a.domain,
      backend: { host: "host.docker.internal", port: XMPP_C2S_PORT, tls: false },
      xmpp: { s2s_port: settings.federation ? XMPP_S2S_PORT : null, http_port: settings.files.on || settings.web ? 5280 : null, cert_sync: { container: t2.name, dir: PROSODY_CERT_DIR } },
    };
    try {
      await saveRoutes(user, where, { rev: configRev(current), routes: [...current.routes, route], fallback: current.fallback });
      routeAdded = true;
    } catch (e) {
      notes.push(`Gluon couldn't add ${a.domain} on Network (${(e as Error).message}). Add it there as a chat server.`);
    }
  }
  audit(user, { action: "chat.install", target: appId, summary: `Set up a chat server for ${a.domain} with ${a.username}@${a.domain} as admin` }, where);
  return { appId, jid: `${a.username}@${a.domain}`, password, routeAdded, notes };
}
