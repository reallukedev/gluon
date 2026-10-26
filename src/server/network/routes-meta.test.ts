import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppSummary } from "../docker/apps";
import type { Route, RoutesConfig } from "../caddy/routes";

// App preferences live in the database; give it a scratch folder.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-routes-meta-"));
vi.stubEnv("GLUON_DATA", root);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const probed: number[] = [];
// Every port looks like it opens without a login, except that 443 can be made "not checked yet" (so Gluon would probe it).
let port443Checked = true;
const noLogin = { result: "none", evidence: "The page opened without asking for a password.", fingerprint: null, admin: false, checkedAt: 1 };
vi.mock("../docker/apps", () => ({ listApps: async () => apps }));
vi.mock("./login-probe", () => ({
  storedProbe: (key: string) => (key.endsWith(":443") && !port443Checked ? null : noLogin),
  loginProbe: async (_host: string, port: number) => (probed.push(port), null),
}));
const { routeApps, routeWarnings } = await import("./routes-meta");

const local = (port: number) => ({ host: "host.docker.internal", port, tls: false });
const app = (id: string, port: number): AppSummary => ({ id, name: id, hasLogin: "unknown", containers: [{ state: "running", image: id, ports: [{ host: port, container: port, proto: "tcp", ip: "" }] }] }) as unknown as AppSummary;
// Caddy's own stack publishes 443, which is the port a site's route names.
const apps = [app("proxy", 443), app("immich", 2283)];

const others: Route[] = [
  { id: "photos", type: "subdomain", name: "Photos", enabled: true, host: "photos.example.test", backend: local(2283) },
  { id: "old-tls", type: "path", name: "Something on 443", enabled: true, path: "/x", backend: local(443), strip_prefix: false },
];
const site: Route = { id: "site-ab12cd34", type: "subdomain", name: "Blog", enabled: true, host: "blog.example.test", backend: local(443), site: { id: "ab12cd34", version: "20261025T120000Z" } };
const cfg = (routes: Route[]): RoutesConfig => ({ base_domain: "example.test", fallback: { name: "Home", backend: local(8130) }, routes });

beforeEach(() => {
  probed.length = 0;
  port443Checked = true;
});

describe("a site's address", () => {
  test("isn't taken for the app that happens to publish Caddy's port, and every other address keeps its app", async () => {
    const withSite = await routeApps(cfg([...others, site]), apps);
    expect(withSite).not.toHaveProperty(site.id);
    expect(withSite).toEqual(await routeApps(cfg(others), apps));
    expect(withSite["old-tls"]).toMatchObject({ appId: "proxy" });
  });

  const photos = others.slice(0, 1);

  test("never gets a no-login warning, and the other warnings don't change", async () => {
    const withSite = await routeWarnings(cfg([...photos, site]), null);
    expect(withSite.map((w) => w.routeId)).toEqual(["photos", "__fallback__"]);
    expect(withSite).toEqual(await routeWarnings(cfg(photos), null));
  });

  test("isn't probed for a login, even before anything on Caddy's port has been checked", async () => {
    port443Checked = false;
    await routeWarnings(cfg([...photos, site]), null);
    expect(probed).toEqual([]);
  });
});
