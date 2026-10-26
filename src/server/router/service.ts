import "server-only";
import { now } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { User } from "../auth/users";
import { tryReadConfig, XMPP_C2S_PORT, XMPP_S2S_PORT } from "../caddy/routes";
import { listApps } from "../docker/apps";
import { serviceKind } from "@/lib/service-kind";
import { RELAY_PORTS, TURN_PORT } from "../chat/turn";
import { gamePortNeeds } from "../games/needs";
import { identify, signOut, withRouter, type RouterPages } from "./bgw-client";
import { deviceOption, forwardForm, ownForm, protocolOption, readForwards, readServices, restartButton, serviceForm, serviceOption, type Page, type RouterForward, type RouterService } from "./bgw-pages";
import { assess, conflicts, covers, isServer, leftovers, planFixes, SERVICE_NAME_MAX, serviceNames, type PortNeed } from "./plan";
import { access, codeOnHold, forget, markRejected, remember, storedGateways, updateCreated, type Access } from "./access";
import { awaitRestart, knownIdentity } from "./monitor";
import { serverNames, whereAmI } from "./where";
import type { RouterStatus } from "@/lib/router-types";

/**
 * The router's settings behind its access code, changed from Gluon. Today: AT&T BGW gateways
 * (BGW320, BGW210), through their own admin pages.
 *
 * Port forwarding: Gluon works out which ports its apps need from the internet, reads what the
 * router forwards, and adds what's missing, re-reading the router after every step. It only
 * removes services it made itself.
 *
 * Restart: presses the router's own Restart button, then waits for it to come back with a fresh
 * uptime before calling it done.
 *
 * Every write checks the page is the one Gluon expects (its own form, the named fields and
 * buttons) and refuses with a plain message when it isn't, rather than guessing.
 */

type Where = { ip: string; zone: string };

/** The ports Gluon's own setup needs from the internet. */
export async function portNeeds(): Promise<PortNeed[]> {
  const cfg = tryReadConfig();
  const apps = await listApps().catch(() => []);
  const out: PortNeed[] = [];
  const add = (n: PortNeed) => {
    if (!out.some((x) => x.key === n.key)) out.push(n);
  };
  if (cfg) {
    add({ key: "web-http", label: "Web (HTTP)", why: "Caddy proves each public address is yours and gets its certificate.", min: 80, max: 80, hostPort: 80, protocol: "tcp" });
    add({ key: "web-https", label: "Web (HTTPS)", why: "People open your public addresses.", min: 443, max: 443, hostPort: 443, protocol: "tcp" });
    for (const r of cfg.routes) {
      if (r.type !== "subdomain" || r.enabled === false) continue;
      if (r.xmpp) {
        add({ key: "chat-c2s", label: "Chat sign-in", why: `Chat apps sign in to ${r.host}.`, min: XMPP_C2S_PORT, max: XMPP_C2S_PORT, hostPort: r.backend.port, protocol: "tcp" });
        if (r.xmpp.s2s_port) add({ key: "chat-s2s", label: "Chat federation", why: "Other chat servers deliver messages.", min: XMPP_S2S_PORT, max: XMPP_S2S_PORT, hostPort: r.xmpp.s2s_port, protocol: "tcp" });
      }
      if (r.voice) add({ key: "voice", label: "Mumble", why: `Mumble apps connect to ${r.host}.`, min: 64738, max: 64738, hostPort: r.voice.port, protocol: "both" });
    }
  }
  for (const n of await gamePortNeeds().catch(() => [])) add(n);
  for (const a of apps) {
    const kind = serviceKind(a.containers.map((c) => c.image));
    if (kind === "mumble") {
      const port = a.containers.flatMap((c) => c.ports).find((p) => p.container === 64738 && p.proto === "tcp")?.host;
      if (port) add({ key: "voice", label: "Mumble", why: "Mumble apps connect from outside your home.", min: 64738, max: 64738, hostPort: port, protocol: "both" });
    }
    if (a.containers.some((c) => /(^|\/)coturn(\/|:|$)/i.test(c.image))) {
      add({ key: "calls-turn", label: "Call relay", why: "Chat apps ask the relay for a route for calls.", min: TURN_PORT, max: TURN_PORT, hostPort: TURN_PORT, protocol: "both" });
      add({ key: "calls-media", label: "Call media", why: "Voice and video between homes and on mobile data.", min: RELAY_PORTS.min, max: RELAY_PORTS.max, hostPort: RELAY_PORTS.min, protocol: "udp" });
    }
  }
  return out;
}

async function readRouter(r: RouterPages) {
  const svc = await r.get("services");
  const hosting = await r.get("apphosting");
  if (!ownForm(svc.page, "services")) throw new AppError("router_page", "Your router's Custom Services page didn't look the way Gluon expects, so Gluon left it alone.", 502);
  if (!ownForm(hosting.page, "apphosting")) throw new AppError("router_page", "Your router's NAT/Gaming page didn't look the way Gluon expects, so Gluon left it alone.", 502);
  const out = { services: readServices(svc.page), forwards: readForwards(hosting.page), svcPage: svc.page, hostingPage: hosting.page };
  remembered().snap = { gateway: r.gateway, at: now(), services: out.services, forwards: out.forwards };
  return out;
}

// ---------------------------------------------------------------- the stored code, used carefully

const rejectedError = () => new AppError("router_code_rejected", "The router no longer accepts the access code Gluon has. Enter it again.", 409, { field: "code" });

/**
 * Run `fn` signed in with the stored code. The code is read when the job reaches the front of
 * the queue (a code entered meanwhile wins), and a code the router refused isn't tried again
 * until someone enters it again or REJECTED_PAUSE_MS passes.
 */
function withStoredCode<T>(gateway: string, fn: (r: RouterPages, a: Access) => Promise<T>): Promise<T> {
  return withRouter(gateway, null, async (r) => {
    const a = access(gateway);
    if (!a) throw new AppError("router_not_connected", "Connect Gluon to your router first.", 409);
    if (codeOnHold(a)) throw rejectedError();
    r.useCode(a.code);
    try {
      return await fn(r, a);
    } catch (e) {
      if (e instanceof AppError && e.code === "router_code") {
        markRejected(gateway, a.code);
        throw rejectedError();
      }
      throw e;
    }
  });
}

// ---------------------------------------------------------------- what the router forwards, cached

/** Port forwarding is read at most this often; pages poll it and every read costs a sign-in. */
const FRESH_MS = 2 * 60_000;
interface Snap {
  gateway: string;
  at: number;
  services: RouterService[];
  forwards: RouterForward[];
}
type GS = typeof globalThis & { __gluonForwarding?: { snap: Snap | null; reading: Promise<Snap> | null } };
const remembered = () => ((globalThis as GS).__gluonForwarding ??= { snap: null, reading: null });

/** The router's services and forwards: from the last read when it's fresh, else one shared read. */
async function forwarding(gateway: string): Promise<Snap> {
  const m = remembered();
  if (m.snap && m.snap.gateway === gateway && now() - m.snap.at < FRESH_MS) return m.snap;
  m.reading ??= withStoredCode(gateway, async (r) => {
    await readRouter(r);
    return m.snap!;
  }).finally(() => {
    m.reading = null;
  });
  return m.reading;
}

const unsupported = (gateway: string, name: string | null) =>
  new AppError("router_unsupported", `Gluon can change settings on AT&T BGW gateways (like the BGW320), and your router at ${gateway}${name ? ` (${name})` : ""} isn't one.`, 409);

export async function routerStatus(): Promise<RouterStatus> {
  const [me, needs] = await Promise.all([whereAmI(), portNeeds()]);
  const base: RouterStatus = { gateway: me.gateway, model: null, firmware: null, supported: false, connected: false, codeRejected: false, connectedBy: null, server: { ip: me.lanIp, mac: me.mac, name: me.hostname }, needs: needs.map((need) => ({ need, status: "unknown", service: null, device: null, ours: false })), leftovers: [], error: null };
  if (!me.gateway) return { ...base, error: "Can't find your router: this server has no default route." };
  const id = knownIdentity(me.gateway) ?? (await identify(me.gateway).catch(() => ({ kind: "unreachable" as const })));
  if (id.kind === "unreachable") return { ...base, error: `Your router at ${me.gateway} didn't answer.` };
  if (id.kind !== "bgw") return base;
  const a = access(me.gateway);
  const st: RouterStatus = { ...base, model: id.model, firmware: id.firmware, supported: true, connected: !!a, connectedBy: a ? { name: a.by, at: a.at } : null };
  if (!a) return st;
  if (codeOnHold(a)) return { ...st, codeRejected: true, error: rejectedError().message };
  try {
    const snap = await forwarding(me.gateway);
    const created = access(me.gateway)?.created ?? a.created;
    const states = assess(needs, snap.services, snap.forwards, { names: serverNames(me) });
    return { ...st, needs: states.map((s) => ({ ...s, ours: !!s.service && created.includes(s.service) })), leftovers: leftovers(created, states, snap.services, snap.forwards) };
  } catch (e) {
    if (e instanceof AppError && e.code === "router_code_rejected") return { ...st, codeRejected: true, error: e.message };
    return { ...st, error: e instanceof Error ? e.message : "Couldn't read your router." };
  }
}

export async function connectRouter(user: User, where: Where, code: string): Promise<RouterStatus> {
  const me = await whereAmI();
  if (!me.gateway) throw new AppError("no_router", "Can't find your router: this server has no default route.", 409);
  const id = await identify(me.gateway);
  if (id.kind === "unreachable") throw new AppError("router_unreachable", `Your router at ${me.gateway} didn't answer. Try again in a minute.`, 502);
  if (id.kind !== "bgw") throw unsupported(me.gateway, id.name);
  // Prove the code works before keeping it.
  await withRouter(me.gateway, code, async (r) => {
    r.useCode(code);
    signOut(me.gateway!);
    await readRouter(r);
  });
  remember(me.gateway, id.model, code, user.displayName || user.username);
  audit(user, { action: "router.connect", target: me.gateway, summary: `Connected Gluon to the router (${id.model}) with its access code` }, where);
  return routerStatus();
}

/** Forget the access code for every router Gluon has one for. Doesn't talk to the router. */
export function forgetRouter(user: User, where: Where): { forgotten: string[] } {
  const gateways = storedGateways();
  for (const gw of gateways) {
    forget(gw);
    signOut(gw);
    audit(user, { action: "router.forget", target: gw, summary: "Removed the router's access code from Gluon" }, where);
  }
  remembered().snap = null;
  return { forgotten: gateways };
}

/** The most the services form lets you type for a name, if it says. */
const nameLimit = (page: Page) => {
  const f = serviceForm(page);
  const field = f ? f.form.fields.find((x) => x.name === f.name) : null;
  return Math.min(SERVICE_NAME_MAX, field?.maxLength ?? SERVICE_NAME_MAX);
};

/**
 * Forward what's missing (all of it, or just `keys`). Nothing is changed if any of it would
 * collide with a port already in use. Each step re-reads the router and checks the change is
 * there before the next, so a refused or silently dropped change stops the run.
 */
export async function fixForwarding(user: User, where: Where, keys: string[] | null): Promise<{ done: string[]; status: RouterStatus }> {
  const me = await whereAmI();
  if (!me.gateway || !me.mac) throw new AppError("no_router", "Can't tell which device on your router is this server.", 409);
  if (!access(me.gateway)) throw new AppError("router_not_connected", "Connect Gluon to your router first.", 409);
  const all = await portNeeds();
  const needs = all.filter((n) => !keys || keys.includes(n.key));
  const done: string[] = [];
  const gateway = me.gateway;
  await withStoredCode(gateway, async (r) => {
    const first = await readRouter(r);
    const server = { names: serverNames(me) };
    const states = assess(needs, first.services, first.forwards, server);
    const clash = conflicts(states, all, first.services, first.forwards, server);
    if (clash.length) throw new AppError("port_conflict", `${clash[0]}${clash.length > 1 ? ` (and ${clash.length - 1} more)` : ""} Gluon changed nothing.`, 409);
    const steps = planFixes(states, first.services.map((s) => s.name), nameLimit(first.svcPage));
    const named = new Map<string, string>();
    try {
      for (const step of steps) {
        if (step.kind === "add-service") {
          const { page } = await r.get("services");
          const f = serviceForm(page);
          if (!f) throw new AppError("router_page", "Couldn't find the form for adding a custom service on your router, so nothing more was changed.", 502);
          const proto = protocolOption(f.protocol, step.need.protocol);
          if (!proto) throw new AppError("router_page", `Your router doesn't offer ${step.need.protocol.toUpperCase()} for custom services.`, 502);
          await r.submit("services", f.form, { [f.name]: step.service, [f.min]: String(step.need.min), [f.max]: String(step.need.max), [f.hostPort]: String(step.need.hostPort), [f.protocol.name]: proto }, f.add);
          const after = readServices((await r.get("services")).page);
          // The router may shorten a long name: find the new service by its ports too.
          const kept = after.find((s) => s.name === step.service) ?? after.find((s) => covers(s, step.need) && !first.services.some((o) => o.name === s.name));
          if (!kept) throw new AppError("router_refused", `Your router didn't keep the "${step.service}" service. Nothing after it was changed.`, 502);
          named.set(step.service, kept.name);
          updateCreated(gateway, (list) => [...list, kept.name]);
          done.push(`Added the service ${kept.name}`);
        } else {
          const service = named.get(step.service) ?? step.service;
          const { page } = await r.get("apphosting");
          const f = forwardForm(page);
          if (!f) throw new AppError("router_page", "Couldn't find the NAT/Gaming form on your router, so nothing more was changed.", 502);
          const names = serviceNames(service);
          const svc = names.map((n) => serviceOption(f.service, n)).find((v) => v !== null) ?? null;
          const dev = deviceOption(f.device, me.mac!);
          if (!svc) throw new AppError("router_page", `Your router doesn't offer "${service}" to forward. It may already go to another device.`, 502);
          if (!dev) throw new AppError("router_page", "Your router's list of devices for NAT/Gaming doesn't include this server. It lists only devices it has seen recently: check this server shows as on under Device List, then try again.", 502);
          await r.submit("apphosting", f.form, { [f.service.name]: svc, [f.device.name]: dev.value }, f.add);
          const after = readForwards((await r.get("apphosting")).page);
          if (!after.some((x) => names.includes(x.service))) throw new AppError("router_refused", `Your router didn't keep the forward for "${service}". Nothing after it was changed.`, 502);
          done.push(`Forwarded ${service} to ${dev.label || me.hostname}`);
        }
      }
    } finally {
      // Whatever happened, the page shows the router as it is now.
      if (steps.length) await readRouter(r).catch(() => (remembered().snap = null));
    }
  });
  audit(user, { action: "router.forward", target: gateway, summary: done.length ? `Router: ${done.join("; ")}` : "Router: everything was already forwarded", detail: { keys } }, where);
  return { done, status: await routerStatus() };
}

/**
 * Stop forwarding a need, or a service Gluon made that nothing needs any more. Only services
 * Gluon made, and only while they go to this server: the forward first (the router won't
 * delete a service in use), then the service.
 */
export async function removeForwarding(user: User, where: Where, target: { key: string } | { service: string }): Promise<RouterStatus> {
  const me = await whereAmI();
  if (!me.gateway || !access(me.gateway)) throw new AppError("router_not_connected", "Connect Gluon to your router first.", 409);
  const need = "key" in target ? (await portNeeds()).find((n) => n.key === target.key) : null;
  if ("key" in target && !need) throw new AppError("not_found", "Gluon doesn't need that port any more. Reload to see what's left on the router.", 404);
  const gateway = me.gateway;
  let removed = "";
  await withStoredCode(gateway, async (r, a) => {
    const now = await readRouter(r);
    const server = { names: serverNames(me) };
    const name = need ? assess([need], now.services, now.forwards, server)[0]!.service : (target as { service: string }).service;
    if (!name || !a.created.includes(name)) throw new AppError("not_ours", "Gluon only removes services it made. Change this one on the router.", 409);
    const fwd = now.forwards.find((f) => f.service === name);
    if (fwd && !isServer(fwd.device, server)) throw new AppError("not_here", `Your router sends "${name}" to ${fwd.device}, not this server, so Gluon left it alone. Change it under NAT/Gaming on the router.`, 409);
    try {
      if (fwd) {
        const form = fwd.remove && now.hostingPage.forms.find((f) => f.buttons.some((b) => b.name === fwd.remove!.name));
        if (!form) throw new AppError("router_page", `Couldn't find the Remove button for "${name}" under NAT/Gaming, so nothing was changed.`, 502);
        await r.submit("apphosting", form, {}, fwd.remove!);
        if (readForwards((await r.get("apphosting")).page).some((f) => f.service === name)) throw new AppError("router_refused", `Your router kept the forward for "${name}". Remove it under NAT/Gaming on the router.`, 502);
      }
      const { page } = await r.get("services");
      const svc = readServices(page).find((s) => s.name === name);
      if (svc) {
        const form = svc.remove && page.forms.find((f) => f.buttons.some((b) => b.name === svc.remove!.name));
        if (!form) throw new AppError("router_page", `Gluon stopped the forward but couldn't find the Remove button for the "${name}" service. Remove it under Custom Services on the router.`, 502);
        await r.submit("services", form, {}, svc.remove!);
        if (readServices((await r.get("services")).page).some((s) => s.name === name)) throw new AppError("router_refused", `Your router kept the "${name}" service. The forward is gone, so nothing reaches this server through it.`, 502);
      }
      removed = name;
      updateCreated(gateway, (list) => list.filter((n) => n !== name));
    } finally {
      await readRouter(r).catch(() => (remembered().snap = null));
    }
  });
  audit(user, { action: "router.unforward", target: gateway, summary: `Router: stopped forwarding ${removed} and removed its service` }, where);
  return routerStatus();
}

/**
 * Restart the router with its own Restart button (on Restart Device, or on Resets in newer
 * firmware). The answer never comes (the router goes down mid-reply), so the check is afterwards:
 * the monitor waits for it to answer with a fresh uptime.
 */
export async function restartRouter(user: User, where: Where): Promise<{ requestedAt: number }> {
  const me = await whereAmI();
  if (!me.gateway || !access(me.gateway)) throw new AppError("router_not_connected", "Connect Gluon to your router first.", 409);
  let model: string | null = null;
  const requestedAt = await withStoredCode(me.gateway, async (r, a) => {
    model = a.model;
    let page = "restart";
    let found = restartButton((await r.get(page)).page);
    if (!found) found = restartButton((await r.get((page = "reset"))).page);
    if (!found) throw new AppError("router_page", "Couldn't find a plain Restart button on your router's Restart Device or Resets pages, so nothing was pressed. Restart it from the router's own page instead.", 502);
    const at = now();
    await r.submit(page, found.form, {}, found.button, { drops: true });
    return at;
  });
  awaitRestart(me.gateway, requestedAt);
  audit(user, { action: "router.restart", target: me.gateway, summary: `Restarted the router (${model ?? "BGW"})` }, where);
  return { requestedAt };
}
