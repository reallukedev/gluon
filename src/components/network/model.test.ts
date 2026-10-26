import { describe, expect, test } from "vitest";
import type { RouteT, RoutesResponse } from "@/lib/network-types";
import { buildEntries } from "./model";

const local = (port: number) => ({ host: "host.docker.internal", port, tls: false });
const photos: RouteT = { id: "photos", type: "subdomain", name: "Photos", enabled: true, host: "photos.example.test", backend: local(2283) };
const site: RouteT = { id: "site-ab12cd34", type: "subdomain", name: "Blog", enabled: true, host: "blog.example.test", backend: local(443), site: { id: "ab12cd34", version: "20261025T120000Z" } };
const shortLink: RouteT = { id: "b", type: "redirect", name: "Blog link", enabled: true, path: "/blog", target: "https://blog.example.test" };

function data(routes: RouteT[]): RoutesResponse {
  const urls: Record<string, string> = { __fallback__: "https://example.test/" };
  for (const r of routes) urls[r.id] = r.type === "subdomain" ? `https://${r.host}` : `https://example.test${r.path}`;
  return {
    config: { base_domain: "example.test", fallback: { name: "Home", backend: local(8130) }, routes },
    rev: "x",
    drift: false,
    caddyRunning: true,
    urls,
    // The proxy stack publishes 443; a site's route must not be filed under it even if the server says so.
    apps: { photos: { appId: "immich", name: "Immich", hasLogin: "unknown" }, [site.id]: { appId: "proxy", name: "proxy", hasLogin: "no" } },
    coveredByWildcard: {},
    certs: {},
  };
}

describe("a site on the Network page", () => {
  test("is its own entry, says it's a public site, and never asks for a login", () => {
    const e = buildEntries(data([photos, site, shortLink]), undefined, undefined, [])!.find((x) => x.main.id === site.id)!;
    expect(e).toMatchObject({ key: "site:ab12cd34", name: "Blog", appId: null, site: { id: "ab12cd34" }, needsLogin: false, login: { tone: "public" } });
    // Its short link folds under it, as it would under an app.
    expect(e.also.map((a) => a.id)).toEqual(["b"]);
  });

  test("leaves every other entry as it was", () => {
    const strip = (es: ReturnType<typeof buildEntries>) => es.filter((x) => !x.site);
    expect(strip(buildEntries(data([photos, site]), undefined, undefined, []))).toEqual(strip(buildEntries(data([photos]), undefined, undefined, [])));
  });
});
