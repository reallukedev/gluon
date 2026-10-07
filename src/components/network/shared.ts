"use client";
import type { AppSummary } from "@/server/docker/apps";
import type { NetworkStatus, RouteT, RoutesConfigT, RoutesResponse, RoutesSaveResponse, ExposureReport, DdnsStatus, ChatServersResponse } from "@/lib/network-types";
import { api, useApi } from "@/lib/client/api";

export const FALLBACK_ID = "__fallback__";
/** How Caddy (in its container) reaches ports on this server. */
export const THIS_SERVER = "host.docker.internal";

export function useRoutes(initial?: RoutesResponse | null) {
  return useApi<RoutesResponse>("/api/network/routes", { refresh: 30_000, fallbackData: initial ?? undefined });
}
export function useNetStatus() {
  return useApi<NetworkStatus>("/api/network/status", { refresh: 30_000 });
}
export function useAppList() {
  return useApi<AppSummary[]>("/api/apps", { refresh: 30_000 });
}
export function useExposure() {
  return useApi<ExposureReport>("/api/network/exposure", { refresh: 120_000 });
}
export function useDdns() {
  return useApi<DdnsStatus>("/api/network/ddns", { refresh: 60_000 });
}

/** Chat servers Gluon can see, and certificate sync per chat address. Only fetched while needed. */
export function useChatServers(on: boolean) {
  return useApi<ChatServersResponse>(on ? "/api/network/xmpp" : null, { refresh: 60_000 });
}

/** The STARTTLS port XMPP apps sign in on; a web address pointed at it is a chat server set up as a web app. */
export const XMPP_CLIENT_PORTS = new Set([5222]);

export function saveRoutes(rev: string, routes: RouteT[], fallback?: RoutesConfigT["fallback"]) {
  return api.put<RoutesSaveResponse>("/api/network/routes", { rev, routes, ...(fallback ? { fallback } : {}) });
}

/** A short link on the base domain, or a whole subdomain that redirects. */
export const isRedirectRoute = (r: RouteT | null | undefined): boolean => !!r && (r.type === "redirect" || (r.type === "subdomain" && !!r.redirect_to));

/** Where a redirect sends people, or null for anything else. */
export const redirectTarget = (r: RouteT | null | undefined): string | null => (!r ? null : r.type === "redirect" ? r.target : r.type === "subdomain" ? (r.redirect_to ?? null) : null);

export const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/**
 * A short, typeable address for an app: "Big Bear CasaOS User Management" → "user-management".
 * Drops store prefixes and keeps whole words within 20 characters.
 */
export function suggestLabel(name: string): string {
  const words = slug(name.replace(/^(big[\s-]?bear|casaos|umbrel|linuxserver)\b[\s-]*/gi, "").replace(/^(big[\s-]?bear|casaos|umbrel)\b[\s-]*/gi, "") || name)
    .split("-")
    .filter(Boolean);
  let out = "";
  for (const w of words.reverse()) {
    const next = out ? `${w}-${out}` : w;
    if (next.length > 20 && out) break;
    out = next;
  }
  return out.slice(0, 30) || slug(name);
}

export function newRouteId(name: string): string {
  const rand = Math.random().toString(16).slice(2, 6);
  return `${slug(name) || "route"}-${rand}`.slice(0, 40);
}

/** Every TCP port an app publishes on this server, its web port first. */
export function tcpPorts(a: AppSummary): number[] {
  const set = new Set<number>();
  if (a.webPort) set.add(a.webPort);
  for (const c of a.containers) for (const p of c.ports) if (p.proto === "tcp") set.add(p.host);
  return [...set];
}

/** Clipboard that also works over plain http on the home network. */
export { copyText } from "@/lib/client/clipboard";
