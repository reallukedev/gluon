import { describe, expect, it } from "vitest";
import type { RoutesConfigT } from "@/lib/network-types";
import { addressRoute, labelError, routesWith } from "./address";

const cfg: RoutesConfigT = {
  base_domain: "server.leech.party",
  fallback: { name: "CasaOS", backend: { host: "host.docker.internal", port: 81, tls: false } },
  routes: [
    { id: "photos-1a2b", type: "subdomain", name: "Immich", enabled: true, host: "photos.server.leech.party", backend: { host: "host.docker.internal", port: 2283, tls: false } },
    { id: "tv", type: "path", name: "Jellyfin", enabled: true, path: "/tv", backend: { host: "host.docker.internal", port: 8096, tls: false }, strip_prefix: false },
  ],
};

describe("a public address for a new app", () => {
  it("refuses labels that aren't one DNS label, or that are taken", () => {
    expect(labelError("", cfg)).toContain("Choose the name");
    expect(labelError("-tv", cfg)).toContain("lowercase letters");
    expect(labelError("my.tv", cfg)).toContain("lowercase letters");
    expect(labelError("photos", cfg)).toBe("photos.server.leech.party already goes to Immich. Choose another name.");
    // A path address (/tv) doesn't take the subdomain.
    expect(labelError("tv", cfg)).toBeNull();
  });

  it("points the subdomain at the app's web port on this server and links it to the app", () => {
    const r = addressRoute(cfg, { id: "jellyfin-9f3c", label: "TV", name: "Jellyfin", appId: "jellyfin", backendHost: "host.docker.internal", port: 8096 });
    expect(r).toEqual({ id: "jellyfin-9f3c", type: "subdomain", name: "Jellyfin", enabled: true, app: "jellyfin", host: "tv.server.leech.party", backend: { host: "host.docker.internal", port: 8096, tls: false } });
  });

  it("keeps every existing route and adds the new one once", () => {
    const r = addressRoute(cfg, { id: "tv-1", label: "tv", name: "Jellyfin", appId: null, backendHost: "host.docker.internal", port: 8096 });
    const first = routesWith(cfg, r);
    expect(first.already).toBe(false);
    expect(first.routes.slice(0, 2)).toEqual(cfg.routes);
    expect(first.routes).toHaveLength(3);
    expect(r.app).toBeUndefined();
    expect(routesWith({ ...cfg, routes: first.routes }, { ...r, id: "tv-2" }).already).toBe(true);
  });
});
