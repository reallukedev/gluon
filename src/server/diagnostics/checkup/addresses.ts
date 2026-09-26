import "server-only";
import { tryReadConfig, caddyRunning, routeUrl, type RoutesConfig } from "../../caddy/routes";
import { listApps, type AppSummary } from "../../docker/apps";
import { getSetting } from "../../settings";
import { FALLBACK_ID } from "../../network/routes-meta";
import type { RouteStatus, TlsResult } from "@/lib/network-types";
import { netStatus } from "./internet";
import { act, fail, go, kv, ms, ok, skip, warn, type CheckCtx, type CheckSpec, type Outcome } from "./core";
import type { CheckFix } from "@/lib/diagnostics-types";

/** Public addresses: Caddy itself, every route answering over HTTPS, and certificates. */

export const apps = (ctx: CheckCtx) => ctx.memo("apps", () => listApps().catch(() => [] as AppSummary[]));
export const displayUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
export const addressHref = (id: string) => `/network?tab=addresses&route=${encodeURIComponent(id)}`;

export function caddyCheck(group: string, hop = false): CheckSpec {
  return {
    id: "addresses.caddy",
    group,
    label: "Caddy",
    hop,
    run: async () => {
      const up = await caddyRunning();
      if (!up) return fail("Caddy isn't answering on its admin socket", { detail: "Caddy is the front door for every public address. If it's stopped, none of them work.", fix: { label: "Open the Proxy app", action: "", href: "/apps/proxy" } });
      return ok("Caddy, the front door for your public addresses, is running");
    },
  };
}

function isStopped(a: AppSummary | undefined) {
  return !!a && a.containers.length > 0 && a.containers.every((c) => c.state !== "running");
}

/** Turn a route's probe results into a checkup outcome, with the right fix. */
export function routeOutcome(r: RouteStatus, list: AppSummary[]): Outcome {
  const where = displayUrl(r.url);
  const evidence = kv([
    ["Address", r.url],
    ["DNS", r.dns ? `${r.dns.status}${r.dns.a.length ? ` → ${r.dns.a.join(", ")}` : ""}${r.dns.proxied ? " (Cloudflare proxy)" : ""}` : null],
    ["Certificate", r.tls ? `${r.tls.status}${r.tls.daysLeft !== null ? `, ${r.tls.daysLeft} days left` : ""}${r.tls.issuer ? `, ${r.tls.issuer}` : ""}` : null],
    ["Through Caddy", r.http ? (r.http.error ?? `HTTP ${r.http.status} in ${ms(r.http.ms)}${r.http.location ? ` → ${r.http.location}` : ""}`) : null],
    ["App port", r.backend ? `${r.backend.host}:${r.backend.port} ${r.backend.reachable ? `answers (${ms(r.backend.ms)})` : `closed: ${r.backend.error}`}` : null],
  ]);
  const findings = [`net.backend:${r.id}`, `net.cert:${r.host}`, `net.dns:${r.host}`];
  const app = r.app ? list.find((a) => a.id === r.app!.appId) : undefined;
  let fix: CheckFix = go("Check the address", addressHref(r.id));
  if (r.backend && !r.backend.reachable && app) fix = isStopped(app) ? act(`Start ${app.name}`, "apps.start", { id: app.id }) : act(`Restart ${app.name}`, "apps.restart", { id: app.id });
  if (!r.enabled) return skip(`${where} is turned off`, { evidence });
  if (r.state === "ok") return ok(r.type === "redirect" ? `${where} redirects as it should` : `${where} answers over HTTPS${r.http?.ms ? ` (${ms(r.http.ms)})` : ""}`, { value: r.http?.ms ? ms(r.http.ms) : null, evidence });
  const title = r.state === "fault" ? `${where} doesn't work` : r.state === "pending" ? `${where} is waiting for a certificate` : `${where} works, with a problem`;
  return { state: r.state === "fault" ? "fail" : "warn", title, detail: r.summary, evidence, findings, fix };
}

function routeCheck(cfg: RoutesConfig, id: string, label: string, group: string): CheckSpec {
  return {
    id: `addresses.route:${id}`,
    group,
    label,
    run: async (ctx) => {
      const [st, list] = await Promise.all([netStatus(ctx), apps(ctx)]);
      const r = st.routes.find((x) => x.id === id);
      if (!r) return skip(`${label} is no longer set up`);
      return routeOutcome(r, list);
    },
  };
}

export function certOutcome(host: string, t: TlsResult | null, routeId: string | null): Outcome {
  if (!t) return skip(`No certificate check for ${host}`);
  const certDays = getSetting("thresholds").certDays;
  const evidence = kv([
    ["Name", host],
    ["Issuer", t.issuer],
    ["Valid until", t.validTo],
    ["Days left", t.daysLeft],
    ["Covers", t.names.slice(0, 6).join(", ")],
    ["Trusted", t.trusted === null ? null : t.trusted ? "yes" : "no"],
  ]);
  const findings = [`net.cert:${host}`];
  const fix = go("See Caddy's log", "/diagnostics?tab=requests");
  if (t.status === "expired") return fail(`The certificate for ${host} has expired`, { detail: "Browsers show a security warning. Caddy renews automatically, so something is blocking renewal: DNS, port forwarding or Let's Encrypt limits.", value: "expired", evidence, findings, fix });
  if (t.status === "ok" && (t.daysLeft ?? 99) >= certDays) return ok(`The certificate for ${host} is good for ${t.daysLeft} more days`, { value: `${t.daysLeft} d`, evidence });
  if (t.status === "expiring" || (t.daysLeft ?? 99) < certDays) return warn(`The certificate for ${host} expires in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`, { detail: "Caddy normally renews 30 days ahead, so renewal seems to be failing. Its log says why.", value: `${t.daysLeft} d`, evidence, findings, fix });
  return warn(t.status === "pending" ? `${host} has no certificate yet` : `The certificate for ${host} isn't trusted`, { detail: t.issueError ?? t.message, evidence, findings, fix: go("Check DNS and certificates", routeId ? addressHref(routeId) : "/network?tab=dns") });
}

function certCheck(host: string, group: string): CheckSpec {
  return {
    id: `addresses.cert:${host}`,
    group,
    label: `Certificate for ${host}`,
    run: async (ctx) => {
      const st = await netStatus(ctx);
      const r = st.routes.find((x) => x.enabled && x.host === host && x.tls);
      return certOutcome(host, r?.tls ?? null, r?.id ?? null);
    },
  };
}

export function addressChecks(): CheckSpec[] {
  const g = "addresses";
  const cfg = tryReadConfig();
  if (!cfg) {
    return [
      {
        id: "addresses.config",
        group: g,
        label: "Public addresses",
        run: async () => skip("Gluon can't read routes.json, so public addresses weren't checked", { detail: "Check that ~/proxy/caddy is mounted into Gluon at /proxy-caddy." }),
      },
    ];
  }
  const specs: CheckSpec[] = [caddyCheck(g)];
  specs.push(routeCheck(cfg, FALLBACK_ID, displayUrl(`https://${cfg.base_domain}/`), g));
  for (const r of cfg.routes) specs.push(routeCheck(cfg, r.id, displayUrl(routeUrl(cfg, r)), g));
  const hosts = new Set<string>([cfg.base_domain]);
  for (const r of cfg.routes) if (r.type === "subdomain" && r.enabled !== false) hosts.add(r.host);
  for (const h of hosts) specs.push(certCheck(h, g));
  return specs;
}

export { routeUrl };
