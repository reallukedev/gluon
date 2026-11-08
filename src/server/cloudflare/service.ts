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
import type { CloudflareStatus, CloudflareZoneT, DnsRecordFull, DnsRecordInput, DnsZoneView, ManagedName, TokenCheck } from "@/lib/cloudflare-types";
import { Cloudflare, CloudflareError } from "./api";
import { inZone, MARK, plan, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";
import { RecordError, toBody } from "./records";

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
/** A DNS name as Cloudflare lists it, optionally a wildcard. */
const DNS_NAME = /^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

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

/** The base domain's zone first, then the rest by name. */
const sortZones = (zones: CloudflareZoneT[], main: CloudflareZoneT) => [main, ...zones.filter((z) => z.id !== main.id).sort((a, b) => a.name.localeCompare(b.name))].slice(0, 500);

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
    const zones = await cf.zones();
    const zone = zones.find((z) => z.id === body.zoneId);
    if (!zone) throw new AppError("invalid", "The token can't see that domain any more. Pick another, or check the token's zone access.", 400, { field: "zoneId" });
    if (!(await cf.canEditDns(zone.id, zone.name))) throw new AppError("no_dns_edit", "The token can read the domain but not change its DNS. Give it Zone · DNS · Edit.", 400, { field: "token" });
    const sameZone = prev?.zone.id === zone.id;
    setSetting("cloudflare", {
      token: encrypt(token),
      tokenHint: hint(token),
      zone,
      zones: sortZones(zones, zone),
      touched: prev?.touched ?? [],
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
    const clean = [...new Set(names.map(norm))].filter((n) => DNS_NAME.test(n) && inZone(n.replace(/^\*\./, ""), c.zone.name));
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
    // The token may have been given more domains (or lost some) since the last pass.
    let zones = c.zones.length ? c.zones : [c.zone];
    try {
      const seen = await cf.zones();
      const main = seen.find((z) => z.id === c.zone.id) ?? c.zone;
      zones = sortZones(seen.length ? seen : [c.zone], main);
    } catch {
      /* keep the saved list; the record calls below say what's wrong */
    }
    const ipv4 = await lookupPublicIpv4(4 * 60_000);
    const ipv6 = c.ipv6 ? (hostGlobalIpv6()[0] ?? null) : null;
    const routes = routesFor(cfg);
    const problems: string[] = [];
    const names: ManagedName[] = [];
    const failed = new Map<string, string>();
    let changed = 0;
    const adoptedNow = new Set<string>();
    const touchedNow = new Set(c.touched);

    for (const z of zones) {
      // A name belongs to the most specific domain that holds it (server.leech.party over leech.party).
      const owns = (host: string) => zoneFor(zones, norm(host))?.id === z.id;
      const mine = routes.filter((r) => owns(r.host));
      const input: PlanInput = { zone: z.name, baseDomain: owns(cfg.base_domain) ? cfg.base_domain : "", routes: mine, ipv4, ipv6, proxy: c.proxied };
      const wantsHere = !!input.baseDomain || mine.some((r) => r.enabled);
      // Only domains with addresses in them, or where Gluon left records it may need to remove.
      if (!wantsHere && !c.touched.includes(z.id)) continue;
      let existing: ExistingRecord[];
      try {
        existing = await cf.records(z.id);
      } catch (e) {
        problems.push(`${z.name}: ${e instanceof AppError ? e.message : "Couldn't read its records."}`);
        if (e instanceof CloudflareError && (e.cfStatus === 401 || e.cfStatus === 403) && z.id === c.zone.id) break;
        continue;
      }
      const p = plan(input, existing, c.adopted);
      for (const pr of p.problems) if (!problems.includes(pr)) problems.push(pr);
      if (c.proxied && p.names.some((n) => n.want.some((w) => w.proxied))) {
        const ssl = await cf.sslMode(z.id);
        // Flexible means Cloudflare talks plain HTTP to Caddy, which answers with a redirect to HTTPS, forever.
        if (ssl === "flexible" || ssl === "off") problems.push(`${z.name}'s SSL mode is ${ssl === "off" ? "Off" : "Flexible"} in Cloudflare, so proxied addresses loop. Set it to Full (strict) under SSL/TLS.`);
      }
      for (const a of p.actions) {
        if (failed.has(a.name)) continue;
        try {
          if (a.op === "delete") await cf.deleteRecord(z.id, a.id);
          else if (a.op === "update") await cf.updateRecord(z.id, a.id, a.name, a.record, MARK);
          else await cf.createRecord(z.id, a.name, a.record, MARK);
          changed++;
          if (a.op !== "delete") touchedNow.add(z.id);
        } catch (e) {
          failed.set(a.name, e instanceof AppError ? e.message : "Cloudflare refused the change.");
          if (e instanceof CloudflareError && (e.cfStatus === 401 || e.cfStatus === 403)) break;
        }
      }
      // Names whose records already say exactly what Gluon would write (left by an older updater, say):
      // take them over, so the next address change is followed instead of turning into a conflict.
      const foreign = (name: string) => existing.some((r) => norm(r.name) === name && r.comment !== MARK && ["A", "AAAA", "CNAME"].includes(r.type));
      for (const n of p.names) if (n.state === "ok" && !c.adopted.includes(n.name) && foreign(n.name)) adoptedNow.add(n.name);
      for (const n of p.names) {
        names.push({ name: n.name, why: n.why, zone: z.name, want: n.want, have: n.have, state: failed.has(n.name) ? "error" : n.state === "change" ? "changed" : n.state, message: failed.get(n.name) ?? null });
      }
    }

    // Read again before writing: the connection may have changed while Cloudflare was answering.
    const now = connection();
    if (now && now.zone.id === c.zone.id) {
      setSetting("cloudflare", {
        ...now,
        zones,
        touched: [...touchedNow].slice(-500),
        adopted: adoptedNow.size ? [...new Set([...now.adopted, ...adoptedNow])].slice(-500) : now.adopted,
      });
    }
    const ok = !failed.size && !problems.length && !names.some((n) => n.state === "conflict");
    if (changed) invalidateStatus();
    s.last = { at: Date.now(), running: false, ok, ipv4, ipv6, names, problems };
    if (changed || failed.size) publish("cloudflare.sync", { ok });
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
    zones: c ? (c.zones.length ? c.zones : [c.zone]) : [],
    tokenHint: c?.tokenHint ?? null,
    connectedAt: c?.connectedAt ?? null,
    ipv6: c?.ipv6 ?? false,
    proxied: c?.proxied ?? true,
    sync: s.last ? { ...s.last, running: s.running } : { at: null, running: s.running, ok: null, ipv4: null, ipv6: null, names: [], problems: [] },
    ddnsContainer: ddns?.running ? ddns.name : null,
  };
}

// ---------------------------------------------------------------- DNS editor

/** A domain the saved token can see, by its name or id. */
function zoneOf(c: Conn, key: string): CloudflareZoneT {
  const k = norm(key);
  const z = (c.zones.length ? c.zones : [c.zone]).find((x) => x.id === key || x.name === k);
  if (!z) throw new AppError("not_found", "Cloudflare doesn't show that domain to Gluon's token.", 404);
  return z;
}

export async function zoneRecords(key: string): Promise<DnsZoneView> {
  const c = needConnection();
  const zone = zoneOf(c, key);
  const raw = await client(c).allRecords(zone.id);
  const adopted = new Set(c.adopted);
  const records: DnsRecordFull[] = raw
    .map((r) => ({ ...r, name: norm(r.name), managed: r.comment === MARK || (adopted.has(norm(r.name)) && ["A", "AAAA", "CNAME"].includes(r.type) && managedNames().has(norm(r.name))) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.content.localeCompare(b.content));
  return { zone, records, dashboard: `https://dash.cloudflare.com/${zone.accountId}/${zone.name}/dns/records` };
}

/** Names the last sync said Gluon keeps. */
function managedNames(): Set<string> {
  return new Set((st().last?.names ?? []).filter((n) => n.want.length).map((n) => n.name));
}

function bad(e: unknown): never {
  if (e instanceof RecordError) throw new AppError("invalid", e.message, 400, { field: e.field });
  throw e;
}

export async function saveRecord(user: User, where: Where, key: string, id: string | null, input: DnsRecordInput): Promise<DnsZoneView> {
  const c = needConnection();
  const zone = zoneOf(c, key);
  let body;
  try {
    body = toBody(input, zone.name);
  } catch (e) {
    bad(e);
  }
  const cf = client(c);
  if (id) {
    const cur = (await cf.allRecords(zone.id)).find((r) => r.id === id);
    if (!cur) throw new AppError("not_found", "That record is gone. It may have been removed in Cloudflare.", 404);
    if (cur.comment === MARK) throw new AppError("managed", "Gluon keeps this record for a public address. Change the address on the Network page instead.", 409);
  }
  if (managedNames().has(body.name) && ["A", "AAAA", "CNAME"].includes(body.type)) {
    throw new AppError("managed", `${body.name} is a public address Gluon keeps the record for. Change it on the Network page instead.`, 409, { field: "name" });
  }
  await cf.putRecord(zone.id, id, body);
  audit(user, { action: "cloudflare.dns", summary: `${id ? "Changed" : "Added"} the ${body.type} record for ${body.name}`, target: zone.name, detail: { type: body.type, name: body.name, content: body.type === "TXT" ? undefined : body.content, proxied: body.proxied } }, where);
  return zoneRecords(zone.id);
}

export async function removeRecord(user: User, where: Where, key: string, id: string): Promise<DnsZoneView> {
  const c = needConnection();
  const zone = zoneOf(c, key);
  const cf = client(c);
  const cur = (await cf.allRecords(zone.id)).find((r) => r.id === id);
  if (!cur) return zoneRecords(zone.id);
  if (cur.comment === MARK) throw new AppError("managed", "Gluon keeps this record for a public address. Take the address off the internet on the Network page instead.", 409);
  await cf.deleteRecord(zone.id, id);
  audit(user, { action: "cloudflare.dns", summary: `Removed the ${cur.type} record for ${norm(cur.name)}`, target: zone.name, detail: { type: cur.type, name: norm(cur.name) } }, where);
  return zoneRecords(zone.id);
}
