/**
 * A public address for a new app: one subdomain route in the Network page's routes, added
 * through the same API the Network page uses. Pure, so the route it adds can be tested.
 */
import type { RouteT, RoutesConfigT, SubdomainRouteT } from "@/lib/network-types";

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** What's wrong with a subdomain label under `cfg.base_domain`, or null. */
export function labelError(label: string, cfg: Pick<RoutesConfigT, "base_domain" | "routes">): string | null {
  const l = label.trim().toLowerCase();
  if (!l) return "Choose the name people will type, like photos.";
  if (!LABEL_RE.test(l)) return "Use lowercase letters, digits and - (not at the start or end).";
  const host = `${l}.${cfg.base_domain}`;
  const taken = cfg.routes.find((r) => r.type === "subdomain" && r.host === host);
  if (taken) return `${host} already goes to ${taken.name}. Choose another name.`;
  return null;
}

export interface AddressInput {
  id: string;
  label: string;
  /** What the Network page calls it: the app's name. */
  name: string;
  /** Gluon's app id once it runs, so the Network page links the address to the app. */
  appId: string | null;
  /** How Caddy reaches this server from its container. */
  backendHost: string;
  /** The port the app's web page opens on. */
  port: number;
}

export function addressRoute(cfg: Pick<RoutesConfigT, "base_domain">, a: AddressInput): SubdomainRouteT {
  return {
    id: a.id,
    type: "subdomain",
    name: a.name.trim().slice(0, 60) || a.label,
    enabled: true,
    ...(a.appId && /^[A-Za-z0-9._-]{1,80}$/.test(a.appId) ? { app: a.appId } : {}),
    host: `${a.label.trim().toLowerCase()}.${cfg.base_domain}`,
    backend: { host: a.backendHost, port: a.port, tls: false },
  };
}

/**
 * The routes to save: everything as it is, plus this one. Saving again after a reload must not
 * add it twice, so an existing route for the same host and port counts as already done.
 */
export function routesWith(cfg: RoutesConfigT, route: SubdomainRouteT): { routes: RouteT[]; already: boolean } {
  const same = cfg.routes.find((r) => r.type === "subdomain" && r.host === route.host);
  if (same && same.type === "subdomain" && same.backend.port === route.backend.port) return { routes: cfg.routes, already: true };
  return { routes: [...cfg.routes, route], already: false };
}
