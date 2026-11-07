import "server-only";
import crypto from "node:crypto";
import { decrypt, encrypt } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { publish } from "../events";
import { getSetting, setSetting, type SettingValue } from "../settings";
import { docker } from "../docker/client";
import { invalidateApps } from "../docker/apps";
import { findContainer } from "../diagnostics/docker-logs";
import { tryReadConfig, type RoutesConfig } from "../caddy/routes";
import { lookupPublicIpv4 } from "../network/probes";
import { hostGlobalIpv6, invalidateStatus } from "../network/status";
import { setTunnel } from "../network/routes-service";
import type { User } from "../auth/users";
import type { CloudflareStatus, CloudflareZoneT, ManagedName, TokenCheck, TunnelStateT } from "@/lib/cloudflare-types";
import { Cloudflare, CloudflareError } from "./api";
import { ingress, inZone, MARK, plan, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";

/**
 * Settings → Integrations → Cloudflare. With one API token Gluon keeps the zone's DNS pointed at
 * this server (its own dynamic DNS), adds and removes records as addresses come and go, and can run
 * a Cloudflare Tunnel so nothing needs forwarding on the router.
 */

type Conn = NonNullable<SettingValue<"cloudflare">>;
interface Where {
  ip: string;
  zone: string;
}

export const CONNECTOR = "gluon-cloudflared";
const IMAGE = "cloudflare/cloudflared:latest";
const tunnelTarget = (id: string) => `${id}.cfargotunnel.com`;
const hint = (token: string) => (token.length > 8 ? `••••${token.slice(-4)}` : null);

type G = typeof globalThis & {
  __gluonCf?: {
    chain: Promise<unknown>;
    running: boolean;
    last: CloudflareStatus["sync"] | null;
    ingressHash: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    tunnel: { at: number; value: Pick<TunnelStateT, "status" | "connections"> } | null;
  };
};
const g = globalThis as G;
const st = () => (g.__gluonCf ??= { chain: Promise.resolve(), running: false, last: null, ingressHash: null, timer: null, tunnel: null });

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const s = st();
  const next = s.chain.then(fn, fn);
  s.chain = next.catch(() => undefined);
  return next;
}

const connection = (): Conn | null => getSetting("cloudflare");
const client = (c: Pick<Conn, "token">) => new Cloudflare(decrypt(c.token));

function routesFor(cfg: RoutesConfig): PlanRoute[] {
  return cfg.routes.flatMap((r) => (r.type === "subdomain" ? [{ host: r.host, name: r.name, enabled: r.enabled !== false, web: !r.xmpp && !r.voice, direct: !!r.direct }] : []));
}

/** The zone that holds `name`: the longest zone name it ends with. */
export function zoneFor(zones: CloudflareZoneT[], name: string | null): CloudflareZoneT | null {
  if (!name) return zones.length === 1 ? zones[0]! : null;
  return zones.filter((z) => inZone(name, z.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

// ---------------------------------------------------------------- token

/** What a token can do, before anything is saved. */
export async function checkToken(token: string, zoneId?: string | null): Promise<TokenCheck> {
  const cf = new Cloudflare(token.trim());
  let zones: CloudflareZoneT[];
  try {
    zones = await cf.zones();
  } catch (e) {
    return { ok: false, message: e instanceof AppError ? e.message : "Couldn't check the token.", zones: [], suggested: null, dnsEdit: null, tunnels: null };
  }
  if (!zones.length) return { ok: false, message: "The token works but can't see any domains. Give it Zone · Zone · Read for your domain.", zones, suggested: null, dnsEdit: null, tunnels: null };
  const base = tryReadConfig()?.base_domain ?? null;
  const zone = (zoneId ? zones.find((z) => z.id === zoneId) : null) ?? zoneFor(zones, base);
  const [dnsEdit, tunnels] = zone ? await Promise.all([cf.canEditDns(zone.id, zone.name).catch(() => false), cf.canListTunnels(zone.accountId).catch(() => false)]) : [null, null];
  return { ok: true, message: null, zones, suggested: zone?.id ?? null, dnsEdit, tunnels };
}

export function checkSavedToken(): Promise<TokenCheck> {
  const c = connection();
  if (!c) throw new AppError("not_connected", "Connect Cloudflare first.", 409);
  return checkToken(decrypt(c.token), c.zone.id);
}

export async function connect(user: User, where: Where, body: { token?: string; zoneId: string }): Promise<CloudflareStatus> {
  const prev = connection();
  const token = body.token?.trim() || (prev ? decrypt(prev.token) : "");
  if (!token) throw new AppError("invalid", "Paste an API token from Cloudflare.", 400, { field: "token" });
  const cf = new Cloudflare(token);
  const zone = (await cf.zones()).find((z) => z.id === body.zoneId);
  if (!zone) throw new AppError("invalid", "The token can't see that domain any more. Pick another, or check the token's zone access.", 400, { field: "zoneId" });
  const cfg = tryReadConfig();
  if (prev?.tunnel && (prev.zone.id !== zone.id || prev.zone.accountId !== zone.accountId)) {
    throw new AppError("tunnel_on", "Turn the tunnel off before moving to another domain.", 409);
  }
  if (!(await cf.canEditDns(zone.id, zone.name))) throw new AppError("no_dns_edit", "The token can read the domain but not change its DNS. Give it Zone · DNS · Edit.", 400, { field: "token" });
  const sameZone = prev?.zone.id === zone.id;
  setSetting("cloudflare", {
    token: encrypt(token),
    tokenHint: hint(token),
    zone,
    connectedAt: sameZone ? prev!.connectedAt : Date.now(),
    ipv6: prev?.ipv6 ?? false,
    adopted: sameZone ? prev!.adopted : [],
    tunnel: sameZone ? (prev?.tunnel ?? null) : null,
  });
  if (!sameZone) st().last = null;
  audit(user, { action: "cloudflare.connect", summary: prev ? (sameZone ? `Replaced the Cloudflare token for ${zone.name}` : `Moved Cloudflare to ${zone.name}`) : `Connected Cloudflare for ${zone.name}`, target: zone.name, detail: { account: zone.accountName, baseDomain: cfg?.base_domain ?? null } }, where);
  await sync().catch(() => undefined);
  return status();
}

export async function disconnect(user: User, where: Where): Promise<void> {
  const c = connection();
  if (!c) return;
  if (c.tunnel) throw new AppError("tunnel_on", "Turn the tunnel off first, so visitors aren't left pointing at a tunnel nobody runs.", 409);
  setSetting("cloudflare", null);
  st().last = null;
  audit(user, { action: "cloudflare.disconnect", summary: `Disconnected Cloudflare for ${c.zone.name}`, target: c.zone.name }, where);
}

export function setOptions(user: User, where: Where, o: { ipv6?: boolean }): Promise<CloudflareStatus> {
  const c = connection();
  if (!c) throw new AppError("not_connected", "Connect Cloudflare first.", 409);
  if (o.ipv6 !== undefined && o.ipv6 !== c.ipv6) {
    setSetting("cloudflare", { ...c, ipv6: o.ipv6 });
    audit(user, { action: "cloudflare.options", summary: o.ipv6 ? "Started publishing this server's IPv6 address in Cloudflare" : "Stopped publishing IPv6 addresses in Cloudflare", target: c.zone.name }, where);
  }
  return sync().then(status);
}

/** Hand names to Gluon: their current A, AAAA and CNAME records become Gluon's to change. */
export async function adopt(user: User, where: Where, names: string[]): Promise<CloudflareStatus> {
  const c = connection();
  if (!c) throw new AppError("not_connected", "Connect Cloudflare first.", 409);
  const clean = [...new Set(names.map((n) => n.trim().toLowerCase().replace(/\.$/, "")))].filter((n) => inZone(n.replace(/^\*\./, ""), c.zone.name));
  if (!clean.length) return status();
  setSetting("cloudflare", { ...c, adopted: [...new Set([...c.adopted, ...clean])].slice(-500) });
  audit(user, { action: "cloudflare.adopt", summary: `Let Gluon manage ${clean.length === 1 ? clean[0] : `${clean.length} names`} in Cloudflare`, target: c.zone.name, detail: { names: clean } }, where);
  await sync();
  return status();
}

// ---------------------------------------------------------------- sync

/** Soon after a change, coalescing bursts (a save that touches several addresses). */
export function scheduleSync(ms = 1500) {
  if (!connection()) return;
  const s = st();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void sync().catch(() => undefined);
  }, ms);
  s.timer.unref?.();
}

export function sync(): Promise<CloudflareStatus["sync"]> {
  return serial(async () => {
    const s = st();
    const c = connection();
    const cfg = tryReadConfig();
    const empty = { at: Date.now(), running: false, ipv4: null, ipv6: null, names: [] as ManagedName[] };
    if (!c) return (s.last = { ...empty, ok: null, problems: [] });
    if (!cfg) return (s.last = { ...empty, ok: false, problems: ["Set up public addresses on the Network page first; DNS follows them."] });
    s.running = true;
    try {
      const cf = client(c);
      const ipv4 = await lookupPublicIpv4(4 * 60_000);
      const ipv6 = c.ipv6 ? (hostGlobalIpv6()[0] ?? null) : null;
      const tunnelHost = cfg.tunnel && c.tunnel ? tunnelTarget(c.tunnel.id) : null;
      const input: PlanInput = { zone: c.zone.name, baseDomain: cfg.base_domain, routes: routesFor(cfg), ipv4, ipv6, tunnelHost };
      const existing = await cf.records(c.zone.id);
      const p = plan(input, existing, c.adopted);
      const problems = [...p.problems];
      const failed = new Map<string, string>();
      for (const a of p.actions) {
        if (failed.has(a.name)) continue;
        try {
          if (a.op === "delete") await cf.deleteRecord(c.zone.id, a.id);
          else if (a.op === "update") await cf.updateRecord(c.zone.id, a.id, a.name, a.record, MARK);
          else await cf.createRecord(c.zone.id, a.name, a.record, MARK);
        } catch (e) {
          failed.set(a.name, e instanceof AppError ? e.message : "Cloudflare refused the change.");
          // A revoked token fails every call the same way; say it once.
          if (e instanceof CloudflareError && (e.cfStatus === 401 || e.cfStatus === 403)) break;
        }
      }
      // Names whose records already say exactly what Gluon would write: take them over quietly, so
      // the next address change is followed instead of turning into a conflict.
      const mine = new Set(c.adopted);
      const foreign = (name: string) => existing.some((r: ExistingRecord) => r.name.toLowerCase().replace(/\.$/, "") === name && r.comment !== MARK && ["A", "AAAA", "CNAME"].includes(r.type));
      const fresh = p.names.filter((n) => n.state === "ok" && !mine.has(n.name) && foreign(n.name)).map((n) => n.name);
      if (fresh.length) setSetting("cloudflare", { ...c, adopted: [...new Set([...c.adopted, ...fresh])].slice(-500) });

      if (tunnelHost && c.tunnel) {
        const rules = ingress(input);
        const hash = crypto.createHash("sha256").update(JSON.stringify(rules)).digest("hex");
        if (hash !== s.ingressHash) {
          try {
            await cf.setIngress(c.zone.accountId, c.tunnel.id, rules);
            s.ingressHash = hash;
          } catch (e) {
            problems.push(`Couldn't update the tunnel's routes: ${e instanceof AppError ? e.message : "Cloudflare refused."}`);
          }
        }
      }

      const names: ManagedName[] = p.names.map((n) => ({
        name: n.name,
        why: n.why,
        want: n.want,
        have: n.have,
        state: failed.has(n.name) ? "error" : n.state === "change" ? "changed" : n.state,
        message: failed.get(n.name) ?? null,
      }));
      const ok = !failed.size && !problems.length && !names.some((n) => n.state === "conflict");
      if (p.actions.length) invalidateStatus();
      s.last = { at: Date.now(), running: false, ok, ipv4, ipv6, names, problems };
      if (p.actions.length || failed.size) publish("cloudflare.sync", { ok });
      return s.last;
    } catch (e) {
      s.last = { ...empty, ipv4: s.last?.ipv4 ?? null, ipv6: s.last?.ipv6 ?? null, names: s.last?.names ?? [], ok: false, problems: [e instanceof AppError ? e.message : "Couldn't reach Cloudflare."] };
      return s.last;
    } finally {
      s.running = false;
    }
  });
}

// ---------------------------------------------------------------- tunnel

async function ensureImage(image: string) {
  const d = docker();
  try {
    await d.getImage(image).inspect();
    return;
  } catch {
    /* pull it */
  }
  await new Promise<void>((resolve, reject) => {
    d.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      d.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
  });
}

async function removeConnector() {
  try {
    await docker().getContainer(CONNECTOR).remove({ force: true });
  } catch {
    /* not there */
  }
}

/** cloudflared on the host network, so it reaches Caddy on localhost:80 whatever network Caddy uses. */
async function startConnector(token: string) {
  try {
    await ensureImage(IMAGE);
  } catch (e) {
    throw new AppError("pull_failed", `Couldn't download cloudflared: ${(e as Error).message}`, 424);
  }
  await removeConnector();
  const c = await docker().createContainer({
    name: CONNECTOR,
    Image: IMAGE,
    Cmd: ["tunnel", "--no-autoupdate", "run"],
    // From the environment rather than the command line, so it doesn't show in the process list.
    Env: [`TUNNEL_TOKEN=${token}`],
    Labels: { "gluon.role": "cloudflare-tunnel" },
    HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" } },
  });
  await c.start();
  invalidateApps();
}

export async function enableTunnel(user: User, where: Where): Promise<CloudflareStatus> {
  const c = connection();
  if (!c) throw new AppError("not_connected", "Connect Cloudflare first.", 409);
  const cfg = tryReadConfig();
  if (!cfg) throw new AppError("no_routes", "Set up public addresses on the Network page first.", 409);
  if (!inZone(cfg.base_domain, c.zone.name)) throw new AppError("other_zone", `${cfg.base_domain} isn't in ${c.zone.name}, so the tunnel can't carry it.`, 409);
  const cf = client(c);
  let t = c.tunnel;
  if (!t) {
    const name = `gluon-${getSetting("serverName").toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${crypto.randomBytes(2).toString("hex")}`;
    let made: { id: string; name: string; token: string };
    try {
      made = await cf.createTunnel(c.zone.accountId, name);
    } catch (e) {
      if (e instanceof CloudflareError && (e.cfStatus === 403 || e.cfStatus === 401)) throw new AppError("no_tunnel_edit", "The token can't make tunnels. Add Account · Cloudflare Tunnel · Edit to it, then try again.", 400);
      throw e;
    }
    t = { id: made.id, name: made.name, token: encrypt(made.token), createdAt: Date.now() };
    setSetting("cloudflare", { ...c, tunnel: t });
  }
  const routes = { zone: c.zone.name, baseDomain: cfg.base_domain, routes: routesFor(cfg) };
  await cf.setIngress(c.zone.accountId, t.id, ingress(routes));
  st().ingressHash = null;
  await startConnector(decrypt(t.token));
  // Caddy first (plain HTTP for tunnel names), then DNS: the CNAMEs only lead somewhere that answers.
  await setTunnel(user, where, { zone: c.zone.name });
  audit(user, { action: "cloudflare.tunnel", summary: `Turned on the Cloudflare Tunnel for ${c.zone.name}`, target: c.zone.name, detail: { tunnel: t.name } }, where);
  await sync();
  return status();
}

export async function disableTunnel(user: User, where: Where): Promise<CloudflareStatus> {
  const c = connection();
  if (!c?.tunnel) return status();
  const cfg = tryReadConfig();
  if (cfg?.tunnel) await setTunnel(user, where, null);
  // DNS back to this network's address before the tunnel goes away.
  await sync();
  await removeConnector();
  invalidateApps();
  try {
    await client(c).deleteTunnel(c.zone.accountId, c.tunnel.id);
  } catch {
    /* Cloudflare drops idle tunnels' connections after a while; the name is harmless if it stays */
  }
  setSetting("cloudflare", { ...connection()!, tunnel: null });
  st().tunnel = null;
  audit(user, { action: "cloudflare.tunnel", summary: `Turned off the Cloudflare Tunnel for ${c.zone.name}`, target: c.zone.name }, where);
  return status();
}

/** Restart cloudflared with the saved token (after it was removed by hand, or won't start). */
export async function restartConnector(user: User, where: Where): Promise<CloudflareStatus> {
  const c = connection();
  if (!c?.tunnel) throw new AppError("no_tunnel", "The tunnel is off.", 409);
  await startConnector(decrypt(c.tunnel.token));
  st().tunnel = null;
  audit(user, { action: "cloudflare.tunnel", summary: "Restarted cloudflared", target: c.zone.name }, where);
  return status();
}

async function tunnelState(c: Conn): Promise<TunnelStateT | null> {
  if (!c.tunnel) return null;
  const s = st();
  let cloud = s.tunnel && Date.now() - s.tunnel.at < 20_000 ? s.tunnel.value : null;
  if (!cloud) {
    try {
      const t = await client(c).tunnel(c.zone.accountId, c.tunnel.id);
      cloud = { status: t.status, connections: t.connections };
    } catch {
      cloud = { status: null, connections: 0 };
    }
    s.tunnel = { at: Date.now(), value: cloud };
  }
  const found = await findContainer(CONNECTOR);
  return {
    id: c.tunnel.id,
    name: c.tunnel.name,
    ...cloud,
    container: found ? { name: found.name, running: found.running, state: found.info.State.Status ?? null } : null,
  };
}

// ---------------------------------------------------------------- status

export async function status(): Promise<CloudflareStatus> {
  const c = connection();
  const cfg = tryReadConfig();
  const s = st();
  const ddns = await findContainer("cloudflare-ddns", (x) => /cloudflare-ddns/.test(x.Image)).catch(() => null);
  return {
    connected: !!c,
    network: !!cfg,
    baseDomain: cfg?.base_domain ?? null,
    zone: c?.zone ?? null,
    tokenHint: c?.tokenHint ?? null,
    connectedAt: c?.connectedAt ?? null,
    ipv6: c?.ipv6 ?? false,
    tunnel: c ? await tunnelState(c) : null,
    directHosts: cfg?.tunnel ? cfg.routes.flatMap((r) => (r.type === "subdomain" && r.direct ? [r.host] : [])) : [],
    sync: s.last ? { ...s.last, running: s.running } : { at: null, running: s.running, ok: null, ipv4: null, ipv6: null, names: [], problems: [] },
    ddnsContainer: c && ddns?.running ? ddns.name : null,
  };
}
