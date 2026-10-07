import type { AppSummary } from "@/server/docker/apps";
import type { LineState } from "@/lib/types";
import type { DdnsStatus, ExposureReport, InternetExposure, NetworkStatus, RouteStatus, RouteT, RoutesResponse } from "@/lib/network-types";
import { FALLBACK_ID, bare, isRedirectRoute, redirectTarget } from "./shared";

/**
 * The Network page's model: one entry per app on the internet, with every address that leads to it
 * folded underneath, and the health of each hop between a visitor and the app. Pure functions, so the
 * page, the map and the details dialog all read the same answers.
 */

export type Lane = "direct" | "cloudflare";
export type AddressRole = "main" | "shortLink" | "path" | "subdomain" | "fallback" | "redirect";

export interface Address {
  /** Route id, or FALLBACK_ID. */
  id: string;
  route: RouteT | null;
  url: string;
  lane: Lane;
  role: AddressRole;
  enabled: boolean;
  status: RouteStatus | undefined;
}

export interface ExtraPathInfo {
  paths: string[];
  port: number;
  host: string;
  note?: string;
  /** App that answers on that port, when Gluon can tell. */
  app: string | null;
}

export type LoginTone = "login" | "none" | "partial" | "unknown" | "off" | "loading";

export interface LoginWords {
  tone: LoginTone;
  label: string;
  evidence: string | null;
  adminTool: boolean;
}

export interface Health {
  state: LineState | null;
  label: string;
  /** The full sentence, for the details and a title attribute. */
  sentence: string;
  /** The address that caused a non-ok state, if not the main one. */
  culprit: Address | null;
}

export interface AppEntry {
  key: string;
  appId: string | null;
  name: string;
  icon: string | null;
  main: Address;
  also: Address[];
  extras: ExtraPathInfo[];
  onlyPaths: string[] | null;
  exposure: InternetExposure | null;
  isFallback: boolean;
  /** A redirect that doesn't lead to one of our own subdomains. */
  isRedirect: boolean;
  /** Any of its addresses is on. */
  on: boolean;
  health: Health;
  login: LoginWords;
  /** Plain sentence of what's wrong with protection, for the inline needs-you strip. */
  needsLogin: boolean;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

function laneOf(r: RouteT | null, st: RouteStatus | undefined, baseProxied: boolean | null): Lane {
  if (st?.dns?.proxied === true) return "cloudflare";
  if (st?.dns?.proxied === false) return "direct";
  if (!r || r.type !== "subdomain") return baseProxied === false ? "direct" : "cloudflare";
  return "direct";
}

/** Short words for one address's live state. */
export function healthOf(st: RouteStatus | undefined, redirect: boolean): { state: LineState; label: string; sentence: string } | null {
  if (!st) return null;
  const days = st.tls?.daysLeft;
  switch (st.state) {
    case "disabled":
      return { state: "stopped", label: "Off", sentence: "Turned off. It isn't reachable from the internet." };
    case "ok":
      return { state: "running", label: redirect ? "Redirecting" : "Working", sentence: st.summary };
    case "pending":
      return { state: "starting", label: "Getting its certificate", sentence: st.summary };
    case "fault": {
      let label = "Not working";
      if (st.backend && !st.backend.reachable) label = `${st.app?.name ?? "The app"} isn't answering`;
      else if (st.dns?.status === "missing") label = "No DNS record";
      else if (st.tls?.status === "expired") label = "Certificate expired";
      else if (st.http?.status && st.http.status >= 500) label = `Error page (${st.http.status})`;
      else if (st.http?.error) label = "Web server isn't serving it";
      return { state: "unhealthy", label, sentence: st.summary };
    }
    case "attention": {
      let label = "Needs a look";
      if (st.tls?.issueError) label = "No certificate yet";
      else if (st.dns?.status === "mismatch") label = "DNS points elsewhere";
      else if (st.tls?.status === "expiring") label = `Certificate ends in ${days} d`;
      else if (st.tls?.status === "invalid") label = "Certificate problem";
      else if (st.dns?.status === "error") label = "DNS lookup failed";
      else if (redirect) label = "Not redirecting";
      return { state: "attention", label, sentence: st.summary };
    }
    default:
      return { state: "unknown", label: "Not checked", sentence: st.summary };
  }
}

const RANK: Record<LineState, number> = { unhealthy: 5, attention: 4, starting: 3, unknown: 2, running: 1, paused: 1, stopped: 0 };

function loginOf(x: InternetExposure | null, on: boolean, onlyPaths: string[] | null, loading: boolean, isRedirect: boolean): LoginWords {
  if (!on) return { tone: "off", label: "Not on the internet", evidence: null, adminTool: false };
  if (isRedirect) return { tone: "off", label: "Redirect only", evidence: null, adminTool: false };
  if (!x) return { tone: loading ? "loading" : "unknown", label: loading ? "" : "Not checked", evidence: null, adminTool: false };
  const adminTool = x.adminUi;
  if (onlyPaths?.length) return { tone: "partial", label: "Only some paths", evidence: `Only ${onlyPaths.join(", ")} ${onlyPaths.length === 1 ? "is" : "are"} public; everything else answers “not found”.`, adminTool };
  if (x.login.verdict === "login") return { tone: "login", label: "Asks for a login", evidence: x.login.evidence, adminTool };
  if (x.login.verdict === "no-login") return { tone: "none", label: "No login", evidence: x.login.evidence, adminTool };
  return { tone: "unknown", label: "Not sure", evidence: x.login.evidence, adminTool };
}

export function buildEntries(data: RoutesResponse, status: NetworkStatus | undefined, exposure: ExposureReport | undefined, apps: AppSummary[] | undefined): AppEntry[] {
  const cfg = data.config;
  const byStatus = new Map((status?.routes ?? []).map((r) => [r.id, r]));
  const byExposure = new Map((exposure?.internet ?? []).map((x) => [x.routeId, x]));
  const appById = new Map((apps ?? []).map((a) => [a.id, a]));
  const baseProxied = status?.base?.proxied ?? null;
  const addr = (r: RouteT | null, id: string, role: AddressRole): Address => {
    const st = byStatus.get(id);
    return { id, route: r, url: data.urls[id] ?? "", lane: laneOf(r, st, baseProxied), role, enabled: r ? r.enabled !== false : true, status: st };
  };
  const appByPort = (port: number) => (apps ?? []).find((a) => a.containers.some((c) => c.ports.some((p) => p.proto === "tcp" && p.host === port)));

  // 1. Group the routes that serve an app.
  const groups = new Map<string, RouteT[]>();
  for (const r of cfg.routes) {
    if (isRedirectRoute(r)) continue;
    const key = data.apps[r.id]?.appId ?? r.app ?? `route:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // 2. Fold redirects into the app whose subdomain they point at.
  const hostToKey = new Map<string, string>();
  for (const [key, rs] of groups) for (const r of rs) if (r.type === "subdomain") hostToKey.set(r.host.toLowerCase(), key);
  const redirectsFor = new Map<string, RouteT[]>();
  const loose: RouteT[] = [];
  for (const r of cfg.routes) {
    const target = redirectTarget(r);
    if (!target) continue;
    const key = hostToKey.get(hostOf(target)) ?? (r.app && groups.has(r.app) ? r.app : undefined);
    if (key) redirectsFor.set(key, [...(redirectsFor.get(key) ?? []), r]);
    else loose.push(r);
  }

  const entries: AppEntry[] = [];
  const finish = (e: Omit<AppEntry, "on" | "health" | "login" | "needsLogin">): AppEntry => {
    const all = [e.main, ...e.also];
    const on = all.some((a) => a.enabled);
    // Health: the worst enabled address; the main one's words unless another is worse.
    let worst: Address | null = null;
    let worstH: ReturnType<typeof healthOf> = null;
    for (const a of all) {
      if (!a.enabled) continue;
      const h = healthOf(a.status, isRedirectRoute(a.route));
      if (!h) continue;
      if (!worstH || RANK[h.state] > RANK[worstH.state]) {
        worst = a;
        worstH = h;
      }
    }
    let health: Health;
    if (!on) health = { state: "stopped", label: "Off", sentence: "Turned off. It isn't reachable from the internet.", culprit: null };
    else if (!worstH || !worst) health = { state: null, label: "", sentence: "", culprit: null };
    else {
      const other = worst !== e.main && worstH.state !== "running";
      health = {
        state: worstH.state,
        label: other ? `${bare(worst.url)}: ${worstH.label.charAt(0).toLowerCase()}${worstH.label.slice(1)}` : worstH.label,
        sentence: other ? `${bare(worst.url)}: ${worstH.sentence}` : worstH.sentence,
        culprit: other ? worst : null,
      };
    }
    const login = loginOf(e.exposure, e.main.enabled, e.onlyPaths, !exposure, e.isRedirect);
    return { ...e, on, health, login, needsLogin: login.tone === "none" };
  };

  for (const [key, rs] of groups) {
    const main = rs.find((r) => r.type === "subdomain" && r.enabled !== false) ?? rs.find((r) => r.type === "subdomain") ?? rs[0]!;
    const appRef = data.apps[main.id];
    const app = appRef ? appById.get(appRef.appId) : main.app ? appById.get(main.app) : undefined;
    const also: Address[] = [];
    for (const r of rs) if (r !== main) also.push(addr(r, r.id, r.type === "subdomain" ? "subdomain" : "path"));
    for (const r of redirectsFor.get(key) ?? []) also.push(addr(r, r.id, "shortLink"));
    const extras: ExtraPathInfo[] =
      main.type === "subdomain"
        ? (main.extra_paths ?? []).map((x) => ({
            // "/admin" and "/admin/*" read as one path.
            paths: x.paths.filter((p) => !(p.endsWith("/*") && x.paths.includes(p.slice(0, -2)))),
            port: x.backend.port,
            host: x.backend.host,
            note: x.note,
            app: appByPort(x.backend.port)?.name ?? null,
          }))
        : [];
    entries.push(
      finish({
        key,
        appId: appRef?.appId ?? main.app ?? null,
        name: appRef?.name ?? app?.name ?? main.name,
        icon: app?.icon ?? null,
        main: addr(main, main.id, "main"),
        also,
        extras,
        onlyPaths: main.type === "subdomain" && main.only_paths?.length ? main.only_paths : null,
        exposure: byExposure.get(main.id) ?? null,
        isFallback: false,
        isRedirect: false,
      }),
    );
  }

  for (const r of loose) {
    entries.push(
      finish({
        key: `redirect:${r.id}`,
        appId: null,
        name: r.name,
        icon: null,
        main: addr(r, r.id, "redirect"),
        also: [],
        extras: [],
        onlyPaths: null,
        exposure: null,
        isFallback: false,
        isRedirect: true,
      }),
    );
  }

  const fbRef = data.apps[FALLBACK_ID];
  entries.push(
    finish({
      key: FALLBACK_ID,
      appId: fbRef?.appId ?? cfg.fallback.app ?? null,
      name: fbRef?.name ?? cfg.fallback.name,
      icon: fbRef ? (appById.get(fbRef.appId)?.icon ?? null) : null,
      main: addr(null, FALLBACK_ID, "fallback"),
      also: [],
      extras: [],
      onlyPaths: null,
      exposure: byExposure.get(FALLBACK_ID) ?? null,
      isFallback: true,
      isRedirect: false,
    }),
  );

  // Alphabetical, apps that are off after the rest. Order doesn't follow state, so rows never jump.
  return entries.sort((a, b) => Number(!a.on) - Number(!b.on) || Number(a.isRedirect) - Number(b.isRedirect) || a.name.localeCompare(b.name));
}

/** Which entry an address id belongs to (for ?route=). */
export function entryFor(entries: AppEntry[], routeId: string): AppEntry | undefined {
  return entries.find((e) => e.main.id === routeId || e.also.some((a) => a.id === routeId));
}

// ---------------------------------------------------------------- hops

export type HopId = "dns" | "router" | "caddy" | "apps";

export interface HopState {
  state: LineState | null;
  label: string;
  sentence: string;
}

export function dnsHop(status: NetworkStatus | undefined): { direct: HopState; proxy: HopState; overall: HopState } {
  const none: HopState = { state: null, label: "", sentence: "" };
  if (!status) return { direct: none, proxy: none, overall: none };
  const w = status.wildcard;
  const subs = status.routes.filter((r) => r.enabled && r.type === "subdomain" && r.dns);
  const badSub = subs.find((r) => r.dns!.status === "missing") ?? subs.find((r) => r.dns!.status === "mismatch");
  let direct: HopState;
  if (badSub) {
    const d = badSub.dns!;
    direct = d.status === "missing" ? { state: "unhealthy", label: `${badSub.host} has no record`, sentence: d.message } : { state: "attention", label: "Points somewhere else", sentence: d.message };
  } else if (!w) direct = { state: "unknown", label: "Not checked", sentence: "" };
  else if (w.status === "ok") direct = { state: "running", label: w.proxied ? "Proxied" : "Points to your router", sentence: w.message };
  else if (w.status === "missing") direct = subs.length ? { state: "running", label: "Each name has its own record", sentence: w.message } : { state: "attention", label: "No wildcard record", sentence: w.message };
  else if (w.status === "mismatch") direct = { state: "attention", label: "Points somewhere else", sentence: w.message };
  else direct = { state: "unknown", label: "Lookup failed", sentence: w.message };

  const b = status.base;
  let proxy: HopState;
  if (!b) proxy = { state: "unknown", label: "Not checked", sentence: "" };
  else if (b.status === "ok") proxy = b.proxied ? { state: "running", label: "Passing traffic on", sentence: b.message } : { state: "running", label: "Not proxied (direct)", sentence: b.message };
  else if (b.status === "missing") proxy = { state: "unhealthy", label: "No record", sentence: b.message };
  else if (b.status === "mismatch") proxy = { state: "attention", label: "Points somewhere else", sentence: b.message };
  else proxy = { state: "unknown", label: "Lookup failed", sentence: b.message };

  const overall = RANK[direct.state ?? "unknown"] >= RANK[proxy.state ?? "unknown"] ? direct : proxy;
  return { direct, proxy, overall };
}

export function routerHop(status: NetworkStatus | undefined, ddns: DdnsStatus | undefined): HopState & { ip: string | null } {
  const ip = status?.publicIp.v4 ?? ddns?.ipv4?.address ?? null;
  if (!ddns) return { state: null, label: "", sentence: "", ip };
  if (!ddns.container.exists) return { state: "unknown", label: "No address updater", sentence: "Gluon didn't find a dynamic DNS updater, so DNS won't follow if your internet address changes.", ip };
  if (!ddns.container.running) return { state: "attention", label: "Address updater stopped", sentence: ddns.summary, ip };
  if (ddns.errors.length) return { state: "attention", label: "Address updates failing", sentence: ddns.summary, ip };
  if (ddns.state === "ok") return { state: "running", label: "Address kept up to date", sentence: ddns.summary, ip };
  return { state: "unknown", label: "Updater quiet", sentence: ddns.summary, ip };
}

export interface CertRow {
  host: string;
  tls: NonNullable<RouteStatus["tls"]>;
  names: string[];
}

export function certRows(status: NetworkStatus | undefined): CertRow[] {
  const certs: CertRow[] = [];
  for (const r of status?.routes ?? []) {
    if (!r.enabled || !r.tls) continue;
    const c = certs.find((x) => x.host === r.host);
    const who = r.app?.name ?? r.name;
    if (c) {
      if (!c.names.includes(who)) c.names.push(who);
    } else certs.push({ host: r.host, tls: r.tls, names: [who] });
  }
  return certs.sort((a, b) => (a.tls.daysLeft ?? 999) - (b.tls.daysLeft ?? 999) || a.host.localeCompare(b.host));
}

export function caddyHop(status: NetworkStatus | undefined, caddyRunning: boolean): HopState & { certs: number; nextDays: number | null } {
  if (!caddyRunning) return { state: "unhealthy", label: "Not answering", sentence: "Gluon can't reach the web server (Caddy), so nothing can be published or changed.", certs: 0, nextDays: null };
  if (!status) return { state: null, label: "", sentence: "", certs: 0, nextDays: null };
  const certs = certRows(status);
  const days = certs.map((c) => c.tls.daysLeft).filter((d): d is number => d !== null);
  const nextDays = days.length ? Math.min(...days) : null;
  const expired = certs.find((c) => c.tls.status === "expired");
  if (expired) return { state: "unhealthy", label: "A certificate expired", sentence: expired.tls.message, certs: certs.length, nextDays };
  const failing = certs.find((c) => c.tls.issueError || c.tls.status === "invalid" || c.tls.status === "expiring");
  if (failing) return { state: "attention", label: failing.tls.status === "expiring" ? `Certificate ends in ${failing.tls.daysLeft} d` : "A certificate needs a look", sentence: failing.tls.issueError ?? failing.tls.message, certs: certs.length, nextDays };
  if (certs.some((c) => c.tls.status === "pending")) return { state: "starting", label: "Getting a certificate", sentence: "Caddy is fetching a certificate. This usually takes under a minute.", certs: certs.length, nextDays };
  return { state: "running", label: "Answering", sentence: `Serving ${certs.length} certificate${certs.length === 1 ? "" : "s"}; they renew on their own.`, certs: certs.length, nextDays };
}

export function appsHop(entries: AppEntry[] | null): HopState & { count: number } {
  if (!entries) return { state: null, label: "", sentence: "", count: 0 };
  const on = entries.filter((e) => e.on && !e.isRedirect);
  const broken = on.filter((e) => e.health.state === "unhealthy");
  const attn = on.filter((e) => e.health.state === "attention" || e.needsLogin);
  const unchecked = on.some((e) => e.health.state === null);
  if (broken.length) return { state: "unhealthy", label: broken.length === 1 ? `${broken[0]!.name} not working` : `${broken.length} not working`, sentence: "", count: on.length };
  if (attn.length) return { state: "attention", label: attn.length === 1 ? `${attn[0]!.name} needs a look` : `${attn.length} need a look`, sentence: "", count: on.length };
  if (unchecked) return { state: null, label: "", sentence: "", count: on.length };
  return { state: "running", label: on.length ? "All working" : "None yet", sentence: "", count: on.length };
}
