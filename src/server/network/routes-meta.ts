import "server-only";
import { listApps, type AppSummary } from "../docker/apps";
import { one } from "../db";
import { routeUrl, coveredByWildcard, THIS_SERVER, type Route, type RoutesConfig } from "../caddy/routes";
import { storedProbe, loginProbe } from "./login-probe";
import { localBackendHost, isLocalBackend } from "./probes";
import type { RouteAppRef, RouteWarning, RoutesResponse } from "@/lib/network-types";

export const FALLBACK_ID = "__fallback__";

type HasLogin = RouteAppRef["hasLogin"];

function prefFor(appId: string): { name: string | null; hasLogin: HasLogin } {
  try {
    const r = one<{ display_name: string | null; has_login: string | null }>("SELECT display_name, has_login FROM app_prefs WHERE app_id = ?", appId);
    const h = r?.has_login;
    return { name: r?.display_name ?? null, hasLogin: h === "yes" || h === "no" ? h : "unknown" };
  } catch {
    return { name: null, hasLogin: "unknown" };
  }
}

/** Which app each route (and the fallback) leads to. */
export async function routeApps(cfg: RoutesConfig, apps?: AppSummary[]): Promise<Record<string, RouteAppRef>> {
  const list = apps ?? (await listApps().catch(() => [] as AppSummary[]));
  const byId = new Map(list.map((a) => [a.id, a]));
  const out: Record<string, RouteAppRef> = {};
  const ref = (a: AppSummary): RouteAppRef => ({ appId: a.id, name: a.name, hasLogin: a.hasLogin });
  const byPort = (port: number) =>
    list.find((a) => a.containers.some((c) => c.state === "running" && c.ports.some((p) => p.proto === "tcp" && p.host === port))) ??
    list.find((a) => a.containers.some((c) => c.ports.some((p) => p.proto === "tcp" && p.host === port)));

  const running = (a: AppSummary | undefined) => (a && a.containers.some((c) => c.state === "running") ? a : undefined);
  // A running app named by the route wins; then whichever running app publishes the backend port
  // (the route's app id can go stale when a stack is renamed); then the named app even if stopped.
  const pick = (appId: string | null | undefined, backend: { host: string; port: number }) => {
    const named = appId ? byId.get(appId) : undefined;
    const viaPort = backend.host === THIS_SERVER ? byPort(backend.port) : undefined;
    return running(named) ?? running(viaPort) ?? named ?? viaPort;
  };
  for (const r of cfg.routes) {
    if (r.type === "redirect") continue;
    const a = pick(r.app, r.backend) || list.find((x) => x.routes.some((rr) => rr.id === r.id));
    if (a) out[r.id] = ref(a);
    else if (r.app) {
      const p = prefFor(r.app);
      out[r.id] = { appId: r.app, name: p.name ?? r.name, hasLogin: p.hasLogin };
    }
  }
  const fb = cfg.fallback;
  const fa = pick(fb.app, fb.backend);
  if (fa) out[FALLBACK_ID] = ref(fa);
  else if (fb.app) {
    const p = prefFor(fb.app);
    out[FALLBACK_ID] = { appId: fb.app, name: p.name ?? fb.name, hasLogin: p.hasLogin };
  }
  return out;
}

export function routeUrls(cfg: RoutesConfig): Record<string, string> {
  const out: Record<string, string> = { [FALLBACK_ID]: `https://${cfg.base_domain}/` };
  for (const r of cfg.routes) out[r.id] = routeUrl(cfg, r);
  return out;
}

export function wildcardCoverage(cfg: RoutesConfig): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of cfg.routes) if (r.type === "subdomain") out[r.id] = coveredByWildcard(r.host, cfg.base_domain);
  return out;
}

export async function describeConfig(cfg: RoutesConfig): Promise<Pick<RoutesResponse, "urls" | "apps" | "coveredByWildcard">> {
  return { urls: routeUrls(cfg), apps: await routeApps(cfg), coveredByWildcard: wildcardCoverage(cfg) };
}

/** Login verdict for an app behind a route: the admin's declaration wins, then Gluon's own probe. */
export function loginVerdictFor(app: RouteAppRef | null, backend: { host: string; port: number }): { verdict: "login" | "no-login" | "unknown"; reason: string } {
  if (app?.hasLogin === "yes") return { verdict: "login", reason: `${app.name} is marked as having its own login.` };
  if (app?.hasLogin === "no") return { verdict: "no-login", reason: `${app.name} is marked as having no login of its own.` };
  const probe = storedProbe(`${localBackendHost(backend.host)}:${backend.port}`);
  if (probe?.result === "login") return { verdict: "login", reason: probe.evidence };
  if (probe?.result === "none") return { verdict: "no-login", reason: probe.evidence };
  return { verdict: "unknown", reason: probe?.evidence ?? "Gluon hasn't checked it yet." };
}

function publicKey(r: Route): string {
  return r.type === "subdomain" ? `h:${r.host}` : `p:${r.path.toLowerCase()}`;
}

/**
 * Warnings to show after a save: every enabled address that leads to an app with no login of its own
 * (unless only some paths are published). `isNew` marks the ones this save published.
 */
export async function routeWarnings(next: RoutesConfig, prev: RoutesConfig | null): Promise<RouteWarning[]> {
  const apps = await routeApps(next);
  // Look at apps Gluon hasn't checked yet (e.g. the one just published), within a few seconds.
  const unchecked = next.routes.filter(
    (r): r is Exclude<Route, { type: "redirect" }> =>
      r.enabled !== false &&
      r.type !== "redirect" &&
      !(r.type === "subdomain" && r.xmpp) &&
      isLocalBackend(r.backend.host) &&
      (apps[r.id]?.hasLogin ?? "unknown") === "unknown" &&
      !storedProbe(`${localBackendHost(r.backend.host)}:${r.backend.port}`),
  );
  if (unchecked.length) {
    await Promise.race([
      Promise.all(unchecked.map((r) => loginProbe(localBackendHost(r.backend.host), r.backend.port, { tls: r.backend.tls }).catch(() => null))),
      new Promise((res) => setTimeout(res, 6000)),
    ]);
  }
  const wasPublic = new Set((prev?.routes ?? []).filter((r) => r.enabled !== false && r.type !== "redirect").flatMap((r) => [r.id, publicKey(r)]));
  const out: RouteWarning[] = [];
  const url = routeUrls(next);
  for (const r of next.routes) {
    if (r.enabled === false || r.type === "redirect") continue;
    if (r.type === "subdomain" && r.only_paths?.length) continue;
    // Chat accounts always need a password; the client port doesn't speak HTTP to probe anyway.
    if (r.type === "subdomain" && r.xmpp) continue;
    const app = apps[r.id] ?? null;
    const v = loginVerdictFor(app, r.backend);
    if (v.verdict !== "no-login") continue;
    const who = app?.name ?? r.name;
    out.push({
      routeId: r.id,
      message: `${who} has no login of its own, so anyone who finds ${url[r.id]!.replace(/^https:\/\//, "")} can use it. Publish only the paths it needs, or put it behind a login.`,
      isNew: !wasPublic.has(r.id) && !wasPublic.has(publicKey(r)),
    });
  }
  const fbApp = apps[FALLBACK_ID] ?? null;
  const fv = loginVerdictFor(fbApp, next.fallback.backend);
  const fbChanged = !prev || prev.fallback.backend.port !== next.fallback.backend.port || prev.fallback.backend.host !== next.fallback.backend.host;
  if (fv.verdict === "no-login") {
    out.push({ routeId: FALLBACK_ID, message: `${fbApp?.name ?? next.fallback.name} answers everything else on ${next.base_domain} and has no login of its own.`, isNew: fbChanged });
  }
  return out;
}

/** "Added x; removed y; changed z" between two configs, for the audit log. */
export function describeChanges(prev: RoutesConfig | null, next: RoutesConfig): string {
  const url = (cfg: RoutesConfig, r: Route) => routeUrl(cfg, r).replace(/^https:\/\//, "");
  if (!prev) return `Saved ${next.routes.length} public addresses`;
  const before = new Map(prev.routes.map((r) => [r.id, r]));
  const after = new Map(next.routes.map((r) => [r.id, r]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const toggled: string[] = [];
  for (const [id, r] of after) {
    const b = before.get(id);
    if (!b) added.push(url(next, r));
    else if (JSON.stringify(b) !== JSON.stringify(r)) {
      const { enabled: be, ...brest } = b;
      const { enabled: ae, ...arest } = r;
      if (be !== ae && JSON.stringify(brest) === JSON.stringify(arest)) toggled.push(`${ae === false ? "turned off" : "turned on"} ${url(next, r)}`);
      else changed.push(url(next, r));
    }
  }
  for (const [id, r] of before) if (!after.has(id)) removed.push(url(prev, r));
  if (JSON.stringify(prev.fallback) !== JSON.stringify(next.fallback)) changed.push(`${next.base_domain} (everything else)`);
  const parts = [
    added.length ? `added ${added.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
    changed.length ? `changed ${changed.join(", ")}` : "",
    ...toggled,
  ].filter(Boolean);
  if (!parts.length) return "Saved public addresses (no changes)";
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
