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
import { networkStatus } from "../network/status";
import { currentConfig, saveRoutes } from "../network/routes-service";
import { chatSnapshot, createAccount, prosodyFor, updateAccount, writeConfd } from "./prosody";
import { createQuarkAccount, quarkFor, quarkSnapshotOf, quarkStatus, setQuarkSettings, updateQuarkAccount } from "./quark";
import { toQuarkSettings } from "./quark-map";
import { chatApps, isAccountExists } from "./backend";
import { QUARK_IMAGE_RE } from "@/lib/service-kind";
import { docker } from "../docker/client";
import { getApp, invalidateApps, listApps } from "../docker/apps";
import { getSetting, publicBaseUrl } from "../settings";
import { newPassword, type Where } from "./service";
import { checkableCompose, chatRecipe, DOMAIN_RE, installSettings, QUARK_CERT_DIR, QUARK_TURN, type ChatInstall } from "./recipe";
import { alternatePortNotes, isStandardPorts, pickPortSet, QUARK_ALT_PORTS, QUARK_PORT_SETS, quarkPortsFrom, type QuarkPorts } from "@/lib/chat-ports";
import type { ChatServerKind, ChatSettings } from "@/lib/chat-types";

/** The ports each server publishes, in words, for when one is taken. */
const PORTS_NEEDED: Record<ChatServerKind, string> = {
  prosody: "A chat server needs ports 5222, 5269 and 5280.",
  quark: `Quark needs ports 5222, 5223, 5269 and 5280, and ${QUARK_TURN.port} and UDP ${QUARK_TURN.relayMin}-${QUARK_TURN.relayMax} for calls. The other ports Gluon tries (${QUARK_ALT_PORTS.map((p) => p.c2s).join(" and ")} for chat apps, and the ones that go with them) are taken too.`,
};

/** Port clashes the server reports for a recipe: ports something else already listens on. */
async function portConflicts(a: ChatInstall): Promise<string[]> {
  const spec = chatRecipe(a);
  // Prosody's recipe is checked as it is; Quark's relay range is written out so every port counts.
  const checked = a.server === "quark" ? { ...spec, compose: checkableCompose(spec.compose) } : spec;
  const check = await serverChecks(checked, "compose", null).catch(() => null);
  return (check?.issues ?? []).filter((i) => i.level === "error" && /already used/.test(i.message)).map((i) => i.message);
}

/**
 * What the install flow needs to know first: chat servers already here, ports in use, and for
 * Quark the port set it will use (the standard one, or the first alternate nothing holds).
 */
export async function installPlan(domain: string | null, server: ChatServerKind = "quark") {
  const existing = (await chatApps()).map(({ app, kind }) => ({ id: app.id, name: app.name, server: kind }));
  const d = domain && DOMAIN_RE.test(domain) ? domain : "chat.example.com";
  const base: ChatInstall = { server, domain: d, username: "admin", settings: installSettings("chat.example.com") };
  const picked: { ports: QuarkPorts | null; conflicts: string[] } =
    server === "quark" ? await pickPortSet(QUARK_PORT_SETS, (ports) => portConflicts({ ...base, ports })) : { ports: null, conflicts: await portConflicts(base) };
  const alternate = !!picked.ports && !isStandardPorts(picked.ports);
  const cfg = tryReadConfig();
  return {
    existing,
    conflicts: picked.conflicts,
    /** Quark only: the host ports it will publish; null for Prosody or when every set is taken. */
    ports: picked.ports,
    /** Quark gets the alternate ports because something holds the standard ones. */
    alternatePorts: alternate,
    /** What that means for DNS and the router, in sentences. */
    portNotes: alternate && picked.ports ? alternatePortNotes(d, picked.ports) : [],
    baseDomain: cfg?.base_domain ?? null,
    network: !!cfg,
    taken: cfg?.routes.flatMap((r) => (r.type === "subdomain" ? [r.host] : [])) ?? [],
  };
}

/** An app id no compose project or folder in the apps folder uses yet: quark (or prosody), chat-server, quark-2… */
async function freeSlug(server: ChatServerKind): Promise<string> {
  const ids = new Set((await listApps().catch(() => [])).map((x) => x.id));
  const root = await appsRoot().catch(() => null);
  const free = (slug: string) => !ids.has(slug) && !(root && hostExists(path.posix.join(root, slug)));
  for (const slug of [server, "chat-server", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${server}-${n}`)]) if (free(slug)) return slug;
  throw new AppError("no_name", "Couldn't find a free name for the chat server app.", 409);
}

export async function startChatInstall(user: User, where: Where, a: ChatInstall): Promise<string> {
  if (!DOMAIN_RE.test(a.domain)) throw new AppError("invalid", "Enter a domain like chat.example.com.", 400, { field: "domain" });
  const plan = await installPlan(a.domain, a.server);
  if (plan.conflicts.length) throw new AppError("ports_taken", `${plan.conflicts[0]} ${PORTS_NEEDED[a.server]}`, 409);
  const spec = chatRecipe(a.server === "quark" ? { ...a, ports: plan.ports ?? undefined, externalIp: await publicIpv4() } : a);
  return createDraft(user, where, { source: "compose", spec: { ...spec, details: { ...spec.details, slug: await freeSlug(a.server) } } });
}

/** The server's public IPv4 as Network knows it, for Quark's call relay; null when unknown or slow. */
async function publicIpv4(): Promise<string | null> {
  if (process.platform !== "linux") return null; // from a laptop, "the public address" is someone else's network
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000));
  return Promise.race([networkStatus().then((s) => s.publicIp.v4 ?? null).catch(() => null), timeout]);
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
  const settings: ChatSettings = { ...a.settings, contact: a.settings.contact ?? `${a.username}@${a.domain}` };
  const password = newPassword();
  const container = a.server === "quark" ? await setUpQuark(appId, a, settings, password) : await setUpProsody(appId, a, settings, password);

  // Quark may have got the alternate ports; read them back from what the container publishes.
  const ports = a.server === "quark" ? await installedQuarkPorts(appId) : null;
  if (ports && !isStandardPorts(ports)) notes.push(...alternatePortNotes(a.domain, ports));

  const routeAdded = await publishChatDomain(user, where, appId, a, settings, container, ports, notes);
  audit(user, { action: "chat.install", target: appId, summary: `Set up a ${a.server === "quark" ? "Quark" : "Prosody"} chat server for ${a.domain} with ${a.username}@${a.domain} as admin` }, where);
  return { appId, jid: `${a.username}@${a.domain}`, password, routeAdded, notes };
}

/**
 * Quark writes its own config from the environment on first start; Gluon waits until its admin
 * console answers and serves the domain, then applies the settings and makes the first account
 * through it. Every step is safe to run again.
 */
async function setUpQuark(appId: string, a: ChatInstall, settings: ChatSettings, password: string): Promise<string> {
  const app = await getApp(appId);
  if (!app?.containers.some((c) => QUARK_IMAGE_RE.test(c.image))) throw new AppError("not_ready", "Can't find the Quark container.", 409);
  const t = await until("Quark starting", async () => {
    invalidateApps();
    const x = await quarkFor(appId);
    await quarkStatus(x);
    const s = await quarkSnapshotOf(x);
    if (!s.hosts.some((h) => h.host === a.domain)) throw new Error(`no ${a.domain} yet`);
    return x;
  });
  await setQuarkSettings(t, a.domain, toQuarkSettings(settings, settings, a.domain));
  try {
    await createQuarkAccount(t, { host: a.domain, user: a.username, password, role: "admin" });
  } catch (e) {
    if (!isAccountExists(e)) throw e;
    await updateQuarkAccount(t, { host: a.domain, user: a.username, password, signOut: true });
  }
  return t.name;
}

async function installedQuarkPorts(appId: string): Promise<QuarkPorts> {
  invalidateApps();
  const app = await getApp(appId);
  const c = app?.containers.find((x) => QUARK_IMAGE_RE.test(x.image));
  return quarkPortsFrom(c?.ports ?? []);
}

async function setUpProsody(appId: string, a: ChatInstall, settings: ChatSettings, password: string): Promise<string> {
  // Settings first, straight into the app's conf.d, then one restart picks them up. A retry
  // rewrites them, so a bad file from an earlier attempt can't keep Prosody down.
  const app = await getApp(appId);
  const container = app?.containers.find((c) => /prosody/i.test(c.image));
  if (!app?.workingDir || !container) throw new AppError("not_ready", "Can't find the chat server's folder.", 409);
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
  try {
    await createAccount(t2, { host: a.domain, user: a.username, password, role: "admin" });
  } catch (e) {
    if (!/already an account/i.test((e as Error).message)) throw e;
    await updateAccount(t2, { host: a.domain, user: a.username, password, signOut: true });
  }
  return t2.name;
}

/** Publish the chat domain on Network so Caddy gets its certificate, which Gluon then copies in. */
async function publishChatDomain(user: User, where: Where, appId: string, a: ChatInstall, settings: ChatSettings, container: string, ports: QuarkPorts | null, notes: string[]): Promise<boolean> {
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
      backend: { host: "host.docker.internal", port: ports?.c2s ?? XMPP_C2S_PORT, tls: false },
      xmpp: { s2s_port: settings.federation ? (ports?.s2s ?? XMPP_S2S_PORT) : null, http_port: settings.files.on || settings.web ? (ports?.http ?? 5280) : null, cert_sync: { container, dir: a.server === "quark" ? QUARK_CERT_DIR : PROSODY_CERT_DIR } },
    };
    try {
      await saveRoutes(user, where, { rev: configRev(current), routes: [...current.routes, route], fallback: current.fallback });
      routeAdded = true;
    } catch (e) {
      notes.push(`Couldn't add ${a.domain} on Network (${(e as Error).message}). Add it there as a chat server.`);
    }
  }
  return routeAdded;
}
