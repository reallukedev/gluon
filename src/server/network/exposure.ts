import "server-only";
import { tryReadConfig } from "../caddy/routes";
import { listApps, type AppSummary } from "../docker/apps";
import { containerIndex, ownerOfPid, isLoopback, stripMapped } from "../diagnostics/attribution";
import { addressOwners } from "../diagnostics/interfaces";
import { hostListeners, type SsSocket } from "./sockets";
import { loginProbe, type LoginProbe } from "./login-probe";
import { routeApps, routeUrls, FALLBACK_ID } from "./routes-meta";
import { ddnsStatus } from "./ddns";
import { localBackendHost, isLocalBackend, LOCAL_HOST } from "./probes";
import { NOT_CONFIGURED } from "./status";
import { plural, listJoin } from "@/lib/format";
import type { ExposureFlag, ExposureReport, InternetExposure, LanExposure, ListenScope, LoginInfo, RouteAppRef } from "@/lib/network-types";

/**
 * Exposure audit: what can reach what.
 *  (a) the internet → every enabled public address, and whether the app behind it has a login;
 *  (b) the home network → every socket listening on the host (incl. Docker published ports);
 *  (c) flags → public apps without a login, admin tools on the internet, addresses pointing at
 *      ports nothing listens on, databases open to the whole network.
 */

const KNOWN_PORTS: Record<number, { label: string; login?: LoginProbe["result"]; evidence?: string; system?: boolean; db?: boolean }> = {
  22: { label: "SSH (remote terminal)", login: "login", evidence: "SSH always asks for a key or password." },
  53: { label: "DNS server" },
  67: { label: "DHCP server", system: true },
  68: { label: "DHCP client", system: true },
  80: { label: "Caddy (web, redirects to HTTPS)" },
  443: { label: "Caddy (public entry point)" },
  111: { label: "RPC portmapper (NFS)" },
  137: { label: "NetBIOS name service", system: true },
  138: { label: "NetBIOS datagrams", system: true },
  139: { label: "Samba file sharing", login: "unknown", evidence: "Samba can allow guest access; check your share settings." },
  445: { label: "Samba file sharing", login: "unknown", evidence: "Samba can allow guest access; check your share settings." },
  546: { label: "DHCPv6 client", system: true },
  1900: { label: "SSDP / DLNA discovery", system: true },
  2049: { label: "NFS file sharing", login: "unknown", evidence: "NFS trusts clients by address, not by password." },
  3306: { label: "MySQL / MariaDB database", db: true },
  5353: { label: "mDNS (local name discovery)", system: true },
  5432: { label: "PostgreSQL database", db: true },
  6379: { label: "Redis", db: true },
  7359: { label: "Jellyfin discovery", system: true },
  9200: { label: "Elasticsearch", db: true },
  11211: { label: "Memcached", db: true },
  27017: { label: "MongoDB database", db: true },
};

const ADMIN_RE = /(homebridge|portainer|casaos|umbrel|cockpit|webmin|proxmox|adminer|phpmyadmin|pgadmin|dozzle|dockge|yacht|nginx-proxy-manager|pi-?hole|adguard|home-?assistant|unifi|toolbox|user-management|syncthing|\b(?:tend|gluon)\b|router|opnsense|pfsense|truenas|unraid)/i;
const NON_HTTP = new Set([22, 25, 53, 110, 111, 139, 143, 445, 587, 993, 995, 2049, 3306, 5432, 6379, 9200, 11211, 27017]);

type G = typeof globalThis & { __gluonExposure?: { at: number; value: ExposureReport | null; running: Promise<ExposureReport> | null } };
const g = globalThis as G;
const st = () => (g.__gluonExposure ??= { at: 0, value: null, running: null });

const SCOPE_RANK: Record<ListenScope, number> = { local: 0, containers: 1, link: 2, lan: 3, all: 4 };

function scopeOfListen(ip: string, owners: Map<string, string>): ListenScope {
  const a = stripMapped(ip).toLowerCase();
  if (a === "0.0.0.0" || a === "::" || a === "*") return "all";
  if (isLoopback(a)) return "local";
  if (a.startsWith("fe80:")) return "link";
  const iface = owners.get(a);
  if (iface && /^(docker\d*|br-|veth)/.test(iface)) return "containers";
  return "lan";
}

function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function loginInfo(declared: LoginInfo["declared"], probe: LoginProbe | null, fixed?: { result: LoginProbe["result"]; evidence: string }): LoginInfo {
  const p = fixed ? { result: fixed.result, evidence: fixed.evidence, checkedAt: null as number | null } : probe ? { result: probe.result, evidence: probe.evidence, checkedAt: probe.checkedAt as number | null } : null;
  let verdict: LoginInfo["verdict"] = "unknown";
  if (declared === "yes") verdict = "login";
  else if (declared === "no") verdict = "no-login";
  else if (p?.result === "login") verdict = "login";
  else if (p?.result === "none") verdict = "no-login";
  const evidence = declared === "yes" ? "Marked as having its own login." : declared === "no" ? "Marked as having no login of its own." : (p?.evidence ?? null);
  return { declared, probe: p?.result ?? null, evidence, checkedAt: p?.checkedAt ?? null, verdict };
}

async function build(force: boolean): Promise<ExposureReport> {
  const cfg = tryReadConfig();
  if (!cfg) throw NOT_CONFIGURED();
  const [apps, idx, owners, sockets, ddns] = await Promise.all([
    listApps().catch(() => [] as AppSummary[]),
    containerIndex(),
    addressOwners(),
    hostListeners().catch(() => [] as SsSocket[]),
    ddnsStatus().catch(() => null),
  ]);
  const rApps = await routeApps(cfg, apps);
  const urls = routeUrls(cfg);
  const limit = limiter(6);
  const probeAge = force ? 10 * 60_000 : 6 * 3_600_000;
  const appById = new Map(apps.map((a) => [a.id, a]));
  const appByContainer = new Map<string, AppSummary>();
  for (const a of apps) for (const c of a.containers) appByContainer.set(c.id, a);

  // ---- LAN listeners, grouped by proto/port/owner
  interface Group {
    proto: "tcp" | "udp";
    port: number;
    addresses: Set<string>;
    scope: ListenScope;
    pids: Set<number>;
    process: string | null;
    ownerKey: string;
    owner: ReturnType<typeof ownerOfPid> | null;
  }
  const groups = new Map<string, Group>();
  for (const s of sockets) {
    const proc = s.processes[0] ?? null;
    const owner = proc ? ownerOfPid(proc.pid, idx) : null;
    const ownerKey = owner?.kind === "container" ? owner.id : owner?.kind === "service" ? owner.unit : (proc?.name ?? "?");
    const key = `${s.proto}:${s.local.port}:${ownerKey}`;
    const scope = scopeOfListen(s.local.ip, owners);
    const gr = groups.get(key) ?? { proto: s.proto, port: s.local.port, addresses: new Set(), scope, pids: new Set(), process: proc?.name ?? null, ownerKey, owner };
    gr.addresses.add(s.local.ip.includes(":") ? `[${s.local.ip}]` : s.local.ip);
    if (SCOPE_RANK[scope] > SCOPE_RANK[gr.scope]) gr.scope = scope;
    for (const p of s.processes) gr.pids.add(p.pid);
    groups.set(key, gr);
  }

  const localBackends = (r: { backend: { host: string; port: number } }) => isLocalBackend(r.backend.host);
  const routesByPort = new Map<number, string[]>();
  const pubRoutes = [...cfg.routes.filter((r) => r.enabled !== false && r.type !== "redirect"), { id: FALLBACK_ID, backend: cfg.fallback.backend }] as { id: string; backend: { host: string; port: number } }[];
  for (const r of pubRoutes) if (localBackends(r)) routesByPort.set(r.backend.port, [...(routesByPort.get(r.backend.port) ?? []), r.id]);

  const tcpListening = new Map<number, Group>();
  for (const gr of groups.values()) if (gr.proto === "tcp" && gr.scope !== "containers" && gr.scope !== "link") {
    const prev = tcpListening.get(gr.port);
    if (!prev || SCOPE_RANK[gr.scope] > SCOPE_RANK[prev.scope]) tcpListening.set(gr.port, gr);
  }

  const lan: LanExposure[] = await Promise.all(
    [...groups.values()].map((gr) =>
      limit(async (): Promise<LanExposure> => {
        const owner = gr.owner;
        // docker-proxy we couldn't attribute through /proc: fall back to the container publishing this port.
        const byPort = owner?.kind !== "container" && (gr.process === "docker-proxy" || !owner || owner.kind === "process") ? idx.list.find((m) => m.ports.some((p) => p.host === gr.port && p.proto === gr.proto)) : undefined;
        const meta = owner?.kind === "container" ? idx.byId.get(owner.id) : byPort;
        const app = meta ? (appByContainer.get(meta.id) ?? (meta.appId ? appById.get(meta.appId) : undefined)) : owner?.kind === "container" && owner.appId ? appById.get(owner.appId) : undefined;
        const pub = meta?.ports.find((p) => p.host === gr.port && p.proto === gr.proto) ?? null;
        const known = KNOWN_PORTS[gr.port] ?? (pub ? KNOWN_PORTS[pub.container] : undefined);
        const system = !!known?.system || (gr.proto === "udp" && /^(dhcpcd|dhclient|avahi-daemon|nmbd|systemd-(resolve|timesyn|network))/.test(gr.process ?? ""));
        const unit = owner?.kind === "service" ? owner.unit : null;
        const label =
          gr.port === 443 || gr.port === 80
            ? known!.label
            : app
              ? `${app.name}${known && !known.system ? ` (${known.label})` : ""}`
              : meta
                ? `${meta.name}${known && !known.system ? ` (${known.label})` : ""}`
                : (known?.label ?? (unit ? unit.replace(/\.service$/, "") : (gr.process ?? `Port ${gr.port}`)));
        let login: LoginInfo | null = null;
        if (gr.proto === "tcp" && gr.scope !== "local" && !system && gr.port !== 443 && gr.port !== 80) {
          const declared = app ? app.hasLogin : null;
          if (known?.login) login = loginInfo(declared, null, { result: known.login, evidence: known.evidence ?? "" });
          else if (known?.db || (pub && KNOWN_PORTS[pub.container]?.db)) login = loginInfo(declared, null, { result: "unknown", evidence: "Databases usually need a password, but Gluon can't check that from outside." });
          else if (NON_HTTP.has(gr.port)) login = loginInfo(declared, null);
          else {
            const probe = await loginProbe(LOCAL_HOST, gr.port, { maxAgeMs: probeAge }).catch(() => null);
            login = loginInfo(declared === "unknown" ? "unknown" : declared, probe);
          }
        }
        return {
          key: `${gr.proto}:${gr.port}:${gr.ownerKey}`,
          proto: gr.proto,
          port: gr.port,
          addresses: [...gr.addresses].sort(),
          scope: gr.scope,
          label,
          process: gr.process,
          pids: [...gr.pids],
          container: meta ? { id: meta.id, name: meta.name } : owner?.kind === "container" ? { id: owner.id, name: owner.name } : null,
          app: app ? { id: app.id, name: app.name } : null,
          unit,
          published: pub ? { containerPort: pub.container, bindIp: pub.ip || "0.0.0.0" } : null,
          publicRoutes: gr.proto === "tcp" ? (routesByPort.get(gr.port) ?? []) : [],
          login,
          system,
        };
      }),
    ),
  );
  lan.sort((a, b) => Number(a.system) - Number(b.system) || SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] || a.port - b.port || a.proto.localeCompare(b.proto));

  // ---- Internet
  const proxiedNames = new Set(ddns?.config.proxiedDomains ?? []);
  const entries: { id: string; name: string; type: InternetExposure["type"]; host: string; backend: { host: string; port: number; tls: boolean }; onlyPaths: string[] | null; appHint?: string | null }[] = [
    { id: FALLBACK_ID, name: cfg.fallback.name, type: "fallback", host: cfg.base_domain, backend: cfg.fallback.backend, onlyPaths: null },
  ];
  for (const r of cfg.routes) {
    if (r.enabled === false || r.type === "redirect") continue;
    entries.push({ id: r.id, name: r.name, type: r.type, host: r.type === "subdomain" ? r.host : cfg.base_domain, backend: r.backend, onlyPaths: r.type === "subdomain" && r.only_paths?.length ? r.only_paths : null });
  }
  const internet: InternetExposure[] = await Promise.all(
    entries.map((e) =>
      limit(async (): Promise<InternetExposure> => {
        const local = isLocalBackend(e.backend.host);
        const listener = local ? tcpListening.get(e.backend.port) : undefined;
        // The route's app id can be stale (stack renamed); the process actually listening knows better.
        const lo = listener?.owner;
        const listenerApp = lo?.kind === "container" ? appByContainer.get(lo.id) : undefined;
        const named = rApps[e.id];
        const app: RouteAppRef | null =
          named && appById.has(named.appId) ? named : listenerApp ? { appId: listenerApp.id, name: listenerApp.name, hasLogin: listenerApp.hasLogin } : (named ?? null);
        const probeHost = localBackendHost(e.backend.host);
        const probe = await loginProbe(probeHost, e.backend.port, { tls: e.backend.tls, maxAgeMs: probeAge }).catch(() => null);
        const login = loginInfo(app?.hasLogin ?? null, probe);
        // Judge by what the app is, not its image: platforms like Umbrel wrap ordinary apps in their own images.
        const adminUi = ADMIN_RE.test(`${app?.appId ?? ""} ${app?.name ?? ""} ${e.name}`) || (!!probe?.admin && !/umbrel|casaos/i.test(probe.fingerprint ?? ""));
        const listenerOwner = listener?.owner;
        return {
          routeId: e.id,
          name: app?.name ?? e.name,
          url: urls[e.id]!,
          type: e.type,
          onlyPaths: e.onlyPaths,
          backend: { host: e.backend.host, port: e.backend.port },
          app,
          listener: listener ? { process: listener.process, container: listenerOwner?.kind === "container" ? listenerOwner.name : null } : null,
          backendListening: local ? !!listener : null,
          viaCloudflare: proxiedNames.has(e.host),
          adminUi,
          login,
        };
      }),
    ),
  );

  // ---- Flags
  const flags: ExposureFlag[] = [];
  for (const x of internet) {
    const where = x.url.replace(/^https:\/\//, "").replace(/\/$/, "");
    const partial = x.onlyPaths ? ` (only ${listJoin(x.onlyPaths)})` : "";
    if (x.login.verdict === "no-login" && !x.onlyPaths) {
      flags.push({
        id: `exposure.nologin:${x.routeId}`,
        severity: "attention",
        title: `${x.name}${x.adminUi ? ", an admin tool," : ""} is on the internet with no login`,
        detail: `Anyone who finds ${where} can use it. ${x.login.evidence ?? ""} Publish only the paths it needs, turn the address off, or give the app a password.`.trim(),
        subject: x.routeId,
        href: `/network?route=${encodeURIComponent(x.routeId)}`,
      });
    } else if (x.login.verdict === "unknown" && !x.onlyPaths) {
      flags.push({
        id: `exposure.unknown:${x.routeId}`,
        severity: "info",
        title: `Gluon can't tell whether ${x.name} has a login`,
        detail: `${x.login.evidence ?? ""} If you know, mark it in the app's settings so the audit is accurate.`.trim(),
        subject: x.routeId,
        href: x.app ? `/apps/${encodeURIComponent(x.app.appId)}?tab=settings` : `/network?route=${encodeURIComponent(x.routeId)}`,
      });
    }
    if (x.adminUi && x.login.verdict !== "no-login") {
      flags.push({
        id: `exposure.admin:${x.routeId}`,
        severity: "info",
        title: `${x.name}'s admin screens are reachable from the internet${partial}`,
        detail: `${where} leads to a tool that can change this server or your home. ${x.login.verdict === "login" ? "It has a login, so use a strong password and two-factor sign-in if it offers it." : "Make sure it asks for a password."} Keeping it LAN-only is safer.`,
        subject: x.routeId,
        href: `/network?route=${encodeURIComponent(x.routeId)}`,
      });
    }
    if (x.backendListening === false) {
      flags.push({
        id: `exposure.dead:${x.routeId}`,
        severity: "attention",
        title: `${where} points at port ${x.backend.port}, but nothing is listening there`,
        detail: `Visitors get an error page. The app may be stopped, or it moved to another port.`,
        subject: x.routeId,
        href: `/network?route=${encodeURIComponent(x.routeId)}`,
      });
    }
  }
  for (const l of lan) {
    if (l.system || l.scope !== "all") continue;
    const who = l.app?.name ?? l.label;
    const dbPort = KNOWN_PORTS[l.port]?.db || (l.published && KNOWN_PORTS[l.published.containerPort]?.db);
    if (dbPort) {
      flags.push({
        id: `exposure.db:${l.key}`,
        severity: "attention",
        title: `A database (${who}) accepts connections from every device on your network`,
        detail: `Port ${l.port}/${l.proto} is open on all interfaces. Apps on this server don't need that: remove the port from its compose file, or bind it to 127.0.0.1.`,
        subject: l.app?.id ?? l.label,
        href: l.app ? `/apps/${encodeURIComponent(l.app.id)}` : null,
      });
    } else if (l.login?.verdict === "no-login") {
      flags.push({
        id: `exposure.lan:${l.key}`,
        severity: "info",
        title: `${who} opens without a login for anyone on your network`,
        detail: `Port ${l.port} answers on every interface. ${l.publicRoutes.length ? "It's also published to the internet." : "It isn't published to the internet, so only devices at home (and anything on your Wi-Fi) can reach it."}`,
        subject: l.app?.id ?? l.label,
        href: l.app ? `/apps/${encodeURIComponent(l.app.id)}` : null,
      });
    }
  }
  const rank = { fault: 0, attention: 1, info: 2 } as const;
  flags.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // ---- Summary
  const noLogin = internet.filter((x) => x.login.verdict === "no-login" && !x.onlyPaths);
  const partialNoLogin = internet.filter((x) => x.login.verdict !== "login" && x.onlyPaths);
  const admins = internet.filter((x) => x.adminUi);
  const dead = internet.filter((x) => x.backendListening === false);
  const lanAll = lan.filter((l) => !l.system && l.scope === "all");
  const lanNoLogin = lanAll.filter((l) => l.login?.verdict === "no-login");
  const summary: string[] = [];
  summary.push(
    `${plural(internet.length, "address", "addresses")} ${internet.length === 1 ? "is" : "are"} reachable from the internet` +
      (noLogin.length ? `; ${noLogin.length === 1 ? "one leads" : `${noLogin.length} lead`} to an app with no login of its own (${listJoin(noLogin.map((x) => x.name))}).` : ". Every one of them either has a login or Gluon couldn't tell."),
  );
  if (partialNoLogin.length) summary.push(`${listJoin(partialNoLogin.map((x) => x.name))} ${partialNoLogin.length === 1 ? "is" : "are"} only partly public: just the listed paths are reachable.`);
  if (admins.length) summary.push(`${listJoin(admins.map((x) => x.name))} ${admins.length === 1 ? "is an admin tool" : "are admin tools"} reachable from the internet.`);
  if (dead.length) summary.push(`${plural(dead.length, "public address", "public addresses")} ${dead.length === 1 ? "points" : "point"} at a port nothing is listening on (${listJoin(dead.map((x) => `${x.name}, port ${x.backend.port}`))}).`);
  summary.push(
    `${plural(lanAll.length, "service")} accept${lanAll.length === 1 ? "s" : ""} connections from any device on your network` +
      (lanNoLogin.length ? `, and ${lanNoLogin.length} of them ${lanNoLogin.length === 1 ? "opens" : "open"} without a login.` : "."),
  );

  return {
    checkedAt: Date.now(),
    summary,
    counts: { internet: internet.length, internetNoLogin: noLogin.length, lan: lan.filter((l) => !l.system).length, lanAllInterfaces: lanAll.length, lanNoLogin: lanNoLogin.length, flags: flags.filter((f) => f.severity !== "info").length },
    internet,
    lan,
    flags,
  };
}

/** Exposure report, cached a minute; `force` re-runs it and re-probes logins older than 10 minutes. */
export async function exposureReport(opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<ExposureReport> {
  const s = st();
  if (!opts.force && s.value && Date.now() - s.at < (opts.maxAgeMs ?? 60_000)) return s.value;
  if (s.running) return s.running;
  s.running = build(!!opts.force)
    .then((v) => {
      s.value = v;
      s.at = Date.now();
      return v;
    })
    .finally(() => {
      s.running = null;
    });
  return s.running;
}

export function invalidateExposure() {
  st().at = 0;
}

