import "server-only";
import { decrypt, encrypt } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { publish } from "../events";
import { getSetting, setSetting, type SettingValue } from "../settings";
import { ddnsStatus, dockerUp } from "../network/ddns";
import { gameAddresses } from "../games/service";
import { tryReadConfig, type RoutesConfig } from "../caddy/routes";
import { lookupPublicIpv4 } from "../network/probes";
import { hostGlobalIpv6, invalidateStatus } from "../network/status";
import type { User } from "../auth/users";
import type { CloudflareStatus, CloudflareZoneT, DnsRecordFull, DnsRecordInput, DnsZoneView, ManagedName, TokenCheck } from "@/lib/cloudflare-types";
import { edgeCovered } from "@/lib/cloudflare-types";
import { Cloudflare, CloudflareError } from "./api";
import { ddnsNamesOf, handoff } from "./handoff";
import { inZone, MARK, plan, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";
import { RecordError, toBody } from "./records";

/**
 * Settings → Integrations → Cloudflare. With one API token Gluon keeps the zone's DNS pointed at
 * this server (its own dynamic DNS), adds and removes records as addresses come and go, and sends
 * web addresses through Cloudflare's proxy.
 *
 * Beyond the public addresses it keeps game addresses (Minecraft through mc-router, forwarded game
 * ports) and any other names the admin lists, so an older cloudflare-ddns updater can go. While
 * that updater still runs, Gluon leaves the names it writes alone: two updaters on one record take
 * turns rewriting it.
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
    /** The names last deferred to cloudflare-ddns, kept while Docker doesn't answer. */
    defer?: string[];
    /** Whether the token can change each domain's DNS, checked now and then (zone id → when, answer). */
    edit?: Map<string, { at: number; ok: boolean }>;
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
const zonesOf = (c: Conn) => (c.zones.length ? c.zones : [c.zone]);
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
      kept: prev?.kept ?? [],
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
    const clean = [...new Set(names.map(norm))].filter((n) => DNS_NAME.test(n) && !!zoneFor(zonesOf(c), n.replace(/^\*\./, "")));
    if (!clean.length) return;
    setSetting("cloudflare", { ...c, adopted: [...new Set([...c.adopted, ...clean])].slice(-500) });
    audit(user, { action: "cloudflare.adopt", summary: `Let Gluon manage ${clean.length === 1 ? clean[0] : `${clean.length} names`} in Cloudflare`, target: c.zone.name, detail: { names: clean } }, where);
    await syncNow();
  });
  return status();
}

/** Keep another name pointed here: a leftover the old updater kept, a wildcard, anything. */
export async function keepName(user: User, where: Where, body: { name: string; proxied: boolean }): Promise<CloudflareStatus> {
  await serial(async () => {
    const c = needConnection();
    const name = norm(body.name);
    if (!DNS_NAME.test(name)) throw new AppError("invalid", "That isn't a name DNS can hold. Try something like play.example.com or *.mc.example.com.", 400, { field: "name" });
    const zone = zoneFor(zonesOf(c), name.replace(/^\*\./, ""));
    if (!zone) throw new AppError("invalid", `Gluon's token can't see the domain ${name} is in. Give the token access to it in Cloudflare.`, 400, { field: "name" });
    if (c.kept.some((k) => k.name === name)) return;
    const proxied = body.proxied && edgeCovered(name.replace(/^\*\./, "x."), zone.name);
    setSetting("cloudflare", { ...c, kept: [...c.kept, { name, proxied }].slice(0, 200) });
    audit(user, { action: "cloudflare.keep", summary: `Gluon keeps ${name} pointed here${proxied ? " through Cloudflare" : ""}`, target: zone.name, detail: { name, proxied } }, where);
    await syncNow();
  });
  return status();
}

/** Stop keeping a name: the records Gluon keeps there go too, as they do for an address. */
export async function dropName(user: User, where: Where, name: string): Promise<CloudflareStatus> {
  await serial(async () => {
    const c = needConnection();
    const n = norm(name);
    if (!c.kept.some((k) => k.name === n)) return;
    setSetting("cloudflare", { ...c, kept: c.kept.filter((k) => k.name !== n) });
    audit(user, { action: "cloudflare.unkeep", summary: `Gluon stopped keeping ${n}`, target: zoneFor(zonesOf(c), n.replace(/^\*\./, ""))?.name ?? n, detail: { name: n } }, where);
    await syncNow();
  });
  return status();
}

/**
 * Take over from cloudflare-ddns: every name it writes that Gluon doesn't keep yet joins the kept
 * names (proxied as it has them), and all of them are handed to Gluon. While the updater still
 * runs Gluon writes nothing there, so this changes no record by itself.
 */
export async function takeover(user: User, where: Where): Promise<CloudflareStatus> {
  await serial(async () => {
    const d = await ddnsStatus(true).catch(() => null);
    if (!d?.container.exists) throw new AppError("not_found", "cloudflare-ddns isn't on this server any more.", 404);
    // A fresh look first, so names Gluon already keeps aren't listed twice.
    const last = await syncNow();
    const c = needConnection();
    const keeps = new Set([...last.names.filter((n) => n.want.length && !n.kept).map((n) => n.name), ...last.covered]);
    const names = ddnsNamesOf(d).filter((n) => DNS_NAME.test(n) && !!zoneFor(zonesOf(c), n.replace(/^\*\./, "")));
    if (!names.length) return;
    // cloudflare-ddns keeps whatever proxy setting a record already has, so that's what to keep.
    const proxiedNow = (n: string) => {
      const have = last.names.find((x) => x.name === n)?.have ?? [];
      return have.length ? have.some((r) => r.proxied) : d.config.proxiedDomains.includes(n);
    };
    const add = names.filter((n) => !keeps.has(n) && !c.kept.some((k) => k.name === n)).map((n) => ({ name: n, proxied: proxiedNow(n) }));
    setSetting("cloudflare", { ...c, kept: [...c.kept, ...add].slice(0, 200), adopted: [...new Set([...c.adopted, ...names])].slice(-500) });
    audit(
      user,
      { action: "cloudflare.takeover", summary: `Gluon took over ${names.length === 1 ? names[0] : `${names.length} names`} from ${d.container.name}`, target: c.zone.name, detail: { names, added: add.map((a) => a.name) } },
      where,
    );
    const next = await syncNow();
    // Names Gluon didn't keep before had no records in its last look; now they do, so match them.
    const cur = connection();
    if (!cur) return;
    let fixed = false;
    const kept = cur.kept.map((k) => {
      const have = add.some((a) => a.name === k.name) ? (next.names.find((n) => n.name === k.name)?.have ?? []) : [];
      const p = have.some((r) => r.proxied);
      if (!have.length || p === k.proxied) return k;
      fixed = true;
      return { ...k, proxied: p };
    });
    if (fixed) {
      setSetting("cloudflare", { ...cur, kept });
      await syncNow();
    }
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
  const empty = { at: Date.now(), running: false, ipv4: null, ipv6: null, names: [] as ManagedName[], covered: [] as string[], readOnly: [] as string[] };
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
    const [ipv4, games, ddns] = await Promise.all([lookupPublicIpv4(4 * 60_000), gameAddresses(), ddnsStatus(true).catch(() => null)]);
    const ipv6 = c.ipv6 ? (hostGlobalIpv6()[0] ?? null) : null;
    const routes = routesFor(cfg);
    // Names a running cloudflare-ddns still writes. If Docker doesn't answer, it may well still be
    // running, so Gluon keeps holding off on the names it last deferred.
    let defer: string[];
    if (ddns?.container.exists) defer = ddns.container.running ? ddnsNamesOf(ddns) : [];
    else defer = (await dockerUp()) ? [] : (s.defer ?? []);
    s.defer = defer;
    const readOnly: string[] = [];
    const keptSet = new Set(c.kept.map((k) => k.name));
    const problems: string[] = [];
    const names: ManagedName[] = [];
    const covered: string[] = [];
    const failed = new Map<string, string>();
    let changed = 0;
    const adoptedNow = new Set<string>();
    const touchedNow = new Set(c.touched);

    for (const z of zones) {
      // A name belongs to the most specific domain that holds it (server.leech.party over leech.party).
      const owns = (host: string) => zoneFor(zones, norm(host))?.id === z.id;
      const mine = routes.filter((r) => owns(r.host));
      const myGames = (games ?? []).filter((x) => owns(x.host));
      const myKept = c.kept.filter((k) => owns(k.name.replace(/^\*\./, "")));
      const input: PlanInput = { zone: z.name, baseDomain: owns(cfg.base_domain) ? cfg.base_domain : "", routes: mine, ipv4, ipv6, proxy: c.proxied, games: myGames, kept: myKept, defer, partial: games === null };
      const wantsHere = !!input.baseDomain || mine.some((r) => r.enabled) || myGames.length > 0 || myKept.length > 0;
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
      // Names Gluon only waits on here are never written, so a token that can't edit this domain
      // would go unnoticed until the old updater is gone. Ask now and then (a test record).
      if (p.names.some((n) => n.state === "deferred")) {
        const edit = (s.edit ??= new Map());
        let known = edit.get(z.id);
        if (!known || Date.now() - known.at > 6 * 3600_000) {
          known = { at: Date.now(), ok: await cf.canEditDns(z.id, z.name).catch(() => known?.ok ?? true) };
          edit.set(z.id, known);
        }
        if (!known.ok) readOnly.push(z.name);
      }
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
        names.push({
          name: n.name,
          why: n.why,
          zone: z.name,
          want: n.want,
          have: n.have,
          state: failed.has(n.name) ? "error" : n.state === "change" ? "changed" : n.state,
          message: failed.get(n.name) ?? null,
          foreign: n.foreign,
          kept: keptSet.has(n.name),
        });
      }
      covered.push(...p.covered);
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
    if (games === null) problems.push("Couldn't read mc-router's Minecraft addresses, so no records were removed this time.");
    const ok = !failed.size && !problems.length && !names.some((n) => n.state === "conflict");
    if (changed) invalidateStatus();
    s.last = { at: Date.now(), running: false, ok, ipv4, ipv6, names, covered, readOnly, problems };
    if (changed || failed.size) publish("cloudflare.sync", { ok });
    return s.last;
  } catch (e) {
    s.last = { ...empty, ipv4: s.last?.ipv4 ?? null, ipv6: s.last?.ipv6 ?? null, names: s.last?.names ?? [], covered: s.last?.covered ?? [], readOnly: s.last?.readOnly ?? [], ok: false, problems: [e instanceof AppError ? e.message : "Couldn't reach Cloudflare."] };
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
  const ddns = c ? await ddnsStatus().catch(() => null) : null;
  const sync: CloudflareStatus["sync"] = s.last ? { ...s.last, running: s.running } : { at: null, running: s.running, ok: null, ipv4: null, ipv6: null, names: [], covered: [], readOnly: [], problems: [] };
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
    sync,
    kept: c?.kept ?? [],
    handoff: c && ddns?.container.exists ? handoff(ddns, zonesOf(c), sync) : null,
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
    const where = c.kept.some((k) => k.name === body.name) ? "Settings, Integrations, Cloudflare (Other names)" : "the Network page";
    throw new AppError("managed", `Gluon keeps the record for ${body.name}. Change it in ${where} instead.`, 409, { field: "name" });
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
