import "server-only";
import { decrypt, encrypt } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { publish } from "../events";
import { getSetting, setSetting, type SettingValue } from "../settings";
import { findContainer } from "../diagnostics/docker-logs";
import { tryReadConfig, type RoutesConfig } from "../caddy/routes";
import { lookupPublicIpv4 } from "../network/probes";
import { hostGlobalIpv6, invalidateStatus } from "../network/status";
import type { User } from "../auth/users";
import type { CloudflareStatus, CloudflareZoneT, ManagedName, TokenCheck } from "@/lib/cloudflare-types";
import { Cloudflare, CloudflareError } from "./api";
import { inZone, MARK, plan, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";

/**
 * Settings → Integrations → Cloudflare. With one API token Gluon keeps the zone's DNS pointed at
 * this server (its own dynamic DNS), adds and removes records as addresses come and go, and sends
 * web addresses through Cloudflare's proxy.
 *
 * Every change to the saved connection runs through one queue and starts from a fresh read, so a
 * slow sync can never write back an older copy over a newer one (a token just removed, say).
 */

type Conn = NonNullable<SettingValue<"cloudflare">>;
interface Where {
  ip: string;
  zone: string;
}

const hint = (token: string) => (token.length > 8 ? `••••${token.slice(-4)}` : null);
const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

type G = typeof globalThis & {
  __gluonCf?: {
    chain: Promise<unknown>;
    running: boolean;
    last: CloudflareStatus["sync"] | null;
    timer: ReturnType<typeof setTimeout> | null;
  };
};
const g = globalThis as G;
const st = () => (g.__gluonCf ??= { chain: Promise.resolve(), running: false, last: null, timer: null });

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const s = st();
  const next = s.chain.then(fn, fn);
  s.chain = next.catch(() => undefined);
  return next;
}

const connection = (): Conn | null => getSetting("cloudflare");
const client = (c: Pick<Conn, "token">) => new Cloudflare(decrypt(c.token));
function needConnection(): Conn {
  const c = connection();
  if (!c) throw new AppError("not_connected", "Connect Cloudflare first.", 409);
  return c;
}

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
    return { ok: false, message: e instanceof AppError ? e.message : "Couldn't check the token.", zones: [], suggested: null, dnsEdit: null };
  }
  if (!zones.length) return { ok: false, message: "The token works but can't see any domains. Give it Zone · Zone · Read for your domain.", zones, suggested: null, dnsEdit: null };
  const base = tryReadConfig()?.base_domain ?? null;
  const zone = (zoneId ? zones.find((z) => z.id === zoneId) : null) ?? zoneFor(zones, base);
  const dnsEdit = zone ? await cf.canEditDns(zone.id, zone.name).catch(() => false) : null;
  return { ok: true, message: null, zones, suggested: zone?.id ?? null, dnsEdit };
}

export function checkSavedToken(): Promise<TokenCheck> {
  const c = needConnection();
  return checkToken(decrypt(c.token), c.zone.id);
}

export async function connect(user: User, where: Where, body: { token?: string; zoneId: string }): Promise<CloudflareStatus> {
  await serial(async () => {
    const prev = connection();
    const token = body.token?.trim() || (prev ? decrypt(prev.token) : "");
    if (!token) throw new AppError("invalid", "Paste an API token from Cloudflare.", 400, { field: "token" });
    const cf = new Cloudflare(token);
    const zone = (await cf.zones()).find((z) => z.id === body.zoneId);
    if (!zone) throw new AppError("invalid", "The token can't see that domain any more. Pick another, or check the token's zone access.", 400, { field: "zoneId" });
    if (!(await cf.canEditDns(zone.id, zone.name))) throw new AppError("no_dns_edit", "The token can read the domain but not change its DNS. Give it Zone · DNS · Edit.", 400, { field: "token" });
    const sameZone = prev?.zone.id === zone.id;
    setSetting("cloudflare", {
      token: encrypt(token),
      tokenHint: hint(token),
      zone,
      connectedAt: sameZone ? prev!.connectedAt : Date.now(),
      ipv6: prev?.ipv6 ?? false,
      proxied: prev?.proxied ?? true,
      adopted: sameZone ? prev!.adopted : [],
    });
    if (!sameZone) st().last = null;
    audit(
      user,
      {
        action: "cloudflare.connect",
        summary: prev ? (sameZone ? `Replaced the Cloudflare token for ${zone.name}` : `Moved Cloudflare from ${prev.zone.name} to ${zone.name}`) : `Connected Cloudflare for ${zone.name}`,
        target: zone.name,
        detail: { account: zone.accountName, baseDomain: tryReadConfig()?.base_domain ?? null },
      },
      where,
    );
    await syncNow();
  });
  return status();
}

export async function disconnect(user: User, where: Where): Promise<void> {
  await serial(async () => {
    const c = connection();
    if (!c) return;
    setSetting("cloudflare", null);
    st().last = null;
    audit(user, { action: "cloudflare.disconnect", summary: `Disconnected Cloudflare for ${c.zone.name}`, target: c.zone.name }, where);
  });
}

export async function setOptions(user: User, where: Where, o: { ipv6?: boolean; proxied?: boolean }): Promise<CloudflareStatus> {
  await serial(async () => {
    const c = needConnection();
    const next = { ...c, ...(o.ipv6 !== undefined ? { ipv6: o.ipv6 } : {}), ...(o.proxied !== undefined ? { proxied: o.proxied } : {}) };
    if (next.ipv6 === c.ipv6 && next.proxied === c.proxied) return;
    setSetting("cloudflare", next);
    const said = [
      next.ipv6 !== c.ipv6 ? (next.ipv6 ? "started publishing this server's IPv6 address" : "stopped publishing IPv6 addresses") : null,
      next.proxied !== c.proxied ? (next.proxied ? "sent web addresses through Cloudflare's proxy" : "stopped proxying web addresses through Cloudflare") : null,
    ].filter(Boolean);
    audit(user, { action: "cloudflare.options", summary: `Cloudflare: ${said.join(" and ")}`, target: c.zone.name }, where);
    await syncNow();
  });
  return status();
}

/** Hand names to Gluon: their current A, AAAA and CNAME records become Gluon's to change. */
export async function adopt(user: User, where: Where, names: string[]): Promise<CloudflareStatus> {
  await serial(async () => {
    const c = needConnection();
    const clean = [...new Set(names.map(norm))].filter((n) => inZone(n.replace(/^\*\./, ""), c.zone.name));
    if (!clean.length) return;
    setSetting("cloudflare", { ...c, adopted: [...new Set([...c.adopted, ...clean])].slice(-500) });
    audit(user, { action: "cloudflare.adopt", summary: `Let Gluon manage ${clean.length === 1 ? clean[0] : `${clean.length} names`} in Cloudflare`, target: c.zone.name, detail: { names: clean } }, where);
    await syncNow();
  });
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

export const sync = () => serial(syncNow);

/** One pass: read the zone, plan, apply. Only ever called inside the queue. */
async function syncNow(): Promise<CloudflareStatus["sync"]> {
  const s = st();
  const c = connection();
  const cfg = tryReadConfig();
  const empty = { at: Date.now(), running: false, ipv4: null, ipv6: null, names: [] as ManagedName[] };
  if (!c) return (s.last = { ...empty, ok: null, problems: [] });
  if (!cfg) return (s.last = { ...empty, ok: false, problems: ["Set up public addresses on the Network page first. DNS follows them."] });
  s.running = true;
  try {
    const cf = client(c);
    const ipv4 = await lookupPublicIpv4(4 * 60_000);
    const ipv6 = c.ipv6 ? (hostGlobalIpv6()[0] ?? null) : null;
    const input: PlanInput = { zone: c.zone.name, baseDomain: cfg.base_domain, routes: routesFor(cfg), ipv4, ipv6, proxy: c.proxied };
    const [existing, ssl] = await Promise.all([cf.records(c.zone.id), c.proxied ? cf.sslMode(c.zone.id) : Promise.resolve(null)]);
    const p = plan(input, existing, c.adopted);
    const problems = [...p.problems];
    // Flexible means Cloudflare talks plain HTTP to Caddy, which answers with a redirect to HTTPS, forever.
    if (ssl === "flexible" || ssl === "off") problems.push(`Cloudflare's SSL mode is ${ssl === "off" ? "Off" : "Flexible"}, so proxied addresses loop. Set it to Full (strict) under SSL/TLS in Cloudflare.`);
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
        if (e instanceof CloudflareError && (e.cfStatus === 401 || e.cfStatus === 403)) {
          problems.push(e.message);
          break;
        }
      }
    }
    // Names whose records already say exactly what Gluon would write (left by an older updater, say):
    // take them over, so the next address change is followed instead of turning into a conflict.
    const foreign = (name: string) => existing.some((r: ExistingRecord) => norm(r.name) === name && r.comment !== MARK && ["A", "AAAA", "CNAME"].includes(r.type));
    const fresh = p.names.filter((n) => n.state === "ok" && !c.adopted.includes(n.name) && foreign(n.name)).map((n) => n.name);
    if (fresh.length) {
      // Read again: the connection may have changed while Cloudflare was answering.
      const now = connection();
      if (now && now.zone.id === c.zone.id) setSetting("cloudflare", { ...now, adopted: [...new Set([...now.adopted, ...fresh])].slice(-500) });
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
}

// ---------------------------------------------------------------- status

export async function status(): Promise<CloudflareStatus> {
  const c = connection();
  const cfg = tryReadConfig();
  const s = st();
  const ddns = c ? await findContainer("cloudflare-ddns", (x) => /cloudflare-ddns/.test(x.Image)).catch(() => null) : null;
  return {
    connected: !!c,
    network: !!cfg,
    baseDomain: cfg?.base_domain ?? null,
    zone: c?.zone ?? null,
    tokenHint: c?.tokenHint ?? null,
    connectedAt: c?.connectedAt ?? null,
    ipv6: c?.ipv6 ?? false,
    proxied: c?.proxied ?? true,
    sync: s.last ? { ...s.last, running: s.running } : { at: null, running: s.running, ok: null, ipv4: null, ipv6: null, names: [], problems: [] },
    ddnsContainer: ddns?.running ? ddns.name : null,
  };
}
