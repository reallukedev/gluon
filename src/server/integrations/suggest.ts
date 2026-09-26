import "server-only";
import { listApps, type AppSummary, type ContainerSummary } from "../docker/apps";
import { KINDS } from "./registry";
import { listRecords } from "./store";
import type { IntegrationKind, IntegrationSuggestion } from "@/lib/widgets-types";

interface Known {
  kind: IntegrationKind;
  /** Matches the image repository (no registry, no tag), lowercase. */
  image: RegExp;
  name: string;
  /** Port the app listens on inside its container. */
  port: number;
  config?: Record<string, unknown>;
  note?: string;
}

const KNOWN: Known[] = [
  { kind: "jellyfin", image: /(^|\/)jellyfin$/, name: "Jellyfin", port: 8096 },
  { kind: "immich", image: /(^|\/)immich-server$/, name: "Immich", port: 2283 },
  {
    kind: "subsonic",
    image: /(^|\/)navidrome$/,
    name: "Navidrome",
    port: 4533,
    config: { auth: "password" },
  },
  {
    kind: "subsonic",
    image: /(^|\/)octo$/,
    name: "Octo",
    port: 8080,
    config: { auth: "password" },
    note: "Octo passes music requests on to Navidrome, so sign in with your Navidrome username and password. Connect either Octo or Navidrome — not both.",
  },
  {
    kind: "subsonic",
    image: /(^|\/)gonic$/,
    name: "gonic",
    port: 80,
    config: { auth: "password" },
  },
  {
    kind: "subsonic",
    image: /(^|\/)airsonic(-advanced)?$/,
    name: "Airsonic",
    port: 4040,
    config: { auth: "password" },
  },
  { kind: "slskd", image: /(^|\/)slskd$/, name: "slskd", port: 5030 },
  {
    kind: "homebridge",
    image: /(^|\/)homebridge$/,
    name: "Homebridge",
    port: 8581,
  },
];

function repoOf(image: string): string {
  const noDigest = image.split("@")[0]!;
  const lastColon = noDigest.lastIndexOf(":");
  const noTag = lastColon > noDigest.lastIndexOf("/") ? noDigest.slice(0, lastColon) : noDigest;
  const parts = noTag.toLowerCase().split("/");
  // Drop a registry host (has a dot/colon or is localhost).
  if (parts.length > 1 && (/[.:]/.test(parts[0]!) || parts[0] === "localhost")) parts.shift();
  return parts.join("/");
}

function hostPort(c: ContainerSummary, internal: number): number | null {
  if (c.networkMode === "host") return internal;
  return c.ports.find((p) => p.proto === "tcp" && p.container === internal)?.host ?? null;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const portOf = (u: string) => {
  try {
    const x = new URL(u);
    return Number(x.port || (x.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
};
const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(u);

/** One app service Gluon can talk to, found from the running containers. */
export interface Detected {
  key: string;
  kind: IntegrationKind;
  name: string;
  app: AppSummary;
  container: ContainerSummary;
  baseUrl: string;
  port: number;
  running: boolean;
  config: Record<string, unknown>;
  note: string | null;
}

/**
 * Umbrel puts most apps behind its own app proxy: the app's container publishes nothing and the proxy
 * publishes the web port. When that's the case, the proxy's port reaches the app.
 */
function proxyPort(app: AppSummary): number | null {
  if (!app.webPort) return null;
  const proxied = app.containers.some((c) => /app[_-]?proxy/i.test(c.name) || /(^|\/)app-proxy$/.test(repoOf(c.image)));
  return proxied ? app.webPort : null;
}

/** Every service Gluon recognises in the given apps, best candidate per app and kind first. */
export function detectServices(apps: AppSummary[]): Detected[] {
  const found: (Detected & { rank: number })[] = [];
  for (const app of apps) {
    if (app.self) continue;
    for (const c of app.containers) {
      const repo = repoOf(c.image);
      const k = KNOWN.find((x) => x.image.test(repo));
      if (!k) continue;
      const direct = hostPort(c, k.port);
      const viaProxy = direct ? null : proxyPort(app);
      const port = direct ?? viaProxy;
      if (!port) continue;
      const running = c.state === "running";
      // Umbrel's own container (reached through its proxy) beats a stray copy that publishes a port itself.
      const rank = (running ? 0 : 4) + (app.source === "umbrel" && !viaProxy && proxyPort(app) ? 1 : 0) + KNOWN.indexOf(k) / 100;
      found.push({
        key: `${k.kind}:${app.id}:${port}`,
        kind: k.kind,
        name: k.name,
        app,
        container: c,
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        running,
        config: k.config ?? {},
        note: k.note ?? null,
        rank,
      });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.rank - b.rank)
    .filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)))
    .map(({ rank: _rank, ...d }) => d);
}

/** The saved connection that talks to this service, if any. */
export function matchRecord<T extends { kind: IntegrationKind; baseUrl: string; appId: string | null }>(
  d: Pick<Detected, "kind" | "baseUrl" | "port" | "app">,
  records: T[],
): T | null {
  const same = records.filter((e) => e.kind === d.kind);
  return same.find((e) => sameUrl(e.baseUrl, d.baseUrl)) ?? same.find((e) => e.appId === d.app.id) ?? same.find((e) => isLocal(e.baseUrl) && portOf(e.baseUrl) === d.port) ?? null;
}

export async function suggestions(): Promise<IntegrationSuggestion[]> {
  const apps: AppSummary[] = await listApps();
  const existing = listRecords();
  const out: IntegrationSuggestion[] = detectServices(apps).map((d) => ({
    key: d.key,
    kind: d.kind,
    name: d.name,
    appId: d.app.id,
    appName: d.app.name,
    icon: d.app.icon,
    baseUrl: d.baseUrl,
    keyHelp: KINDS[d.kind].keyHelp,
    note: d.note,
    running: d.running,
    alreadyAdded: !!matchRecord(d, existing),
    config: d.config,
  }));
  return out.sort((a, b) => Number(a.alreadyAdded) - Number(b.alreadyAdded) || a.name.localeCompare(b.name));
}
