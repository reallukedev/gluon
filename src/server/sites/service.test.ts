import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RoutesConfig } from "../caddy/routes";

// Drafts, published copies, routes.json and Caddy's admin socket all live in a scratch folder.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-sites-svc-"));
const caddyDir = path.join(root, "caddy");
const socket = path.join(root, "admin.sock");
fs.mkdirSync(caddyDir, { recursive: true });
vi.stubEnv("GLUON_DATA", path.join(root, "data"));
vi.stubEnv("GLUON_CADDY_DIR", caddyDir);
vi.stubEnv("GLUON_CADDY_SOCKET", socket);

const routesFile = path.join(caddyDir, "routes.json");
const writeRoutes = (routes: unknown[]) => fs.writeFileSync(routesFile, JSON.stringify({ base_domain: "example.test", fallback: { name: "Home", backend: { host: "host.docker.internal", port: 8130, tls: false } }, routes }));
const readRoutes = () => JSON.parse(fs.readFileSync(routesFile, "utf8")) as RoutesConfig;

// The checked save is the Network module's; here it only does what each test says happened.
const save = { mode: "persisted-then-threw" as "persisted-then-threw" | "rejected" };
vi.mock("../network/routes-service", () => ({
  saveSiteRoutes: async (_u: unknown, _w: unknown, change: (r: RoutesConfig["routes"]) => RoutesConfig["routes"]) => {
    if (save.mode === "persisted-then-threw") {
      // Caddy took the new config and routes.json was written; something after that failed.
      writeRoutes(change(readRoutes().routes));
      throw new Error("Couldn't refresh the network status");
    }
    throw Object.assign(new Error("Caddy rejected the change"), { code: "caddy_rejected", status: 400 });
  },
}));

// Caddy's admin API. When `caddyLoadedIt`, its running config serves every version folder on disk
// (as if it loaded the new config before the save failed); otherwise none of them.
let caddyLoadedIt = false;
const servedRoots = () => {
  const dir = path.join(caddyDir, "sites");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((id) => fs.readdirSync(path.join(dir, id)).map((v) => `/etc/caddy/sites/${id}/${v}`));
};
const caddy = http.createServer((_req, res) => {
  const routes = (caddyLoadedIt ? servedRoots() : []).map((root) => ({ handle: [{ handler: "file_server", root }] }));
  res.end(JSON.stringify({ apps: { http: { servers: { srv0: { routes } } } } }));
});
beforeAll(() => new Promise<void>((r) => caddy.listen(socket, r)));
afterAll(() => {
  caddy.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const store = await import("./store");
const { publishSite, listSites } = await import("./service");
const { versionsOnDisk } = await import("./versions");

const user = { id: "u1", username: "admin" } as Parameters<typeof publishSite>[0];
const where = { ip: "127.0.0.1", zone: "home" };

async function newSite() {
  const id = store.createSiteRow(user, "Blog").id;
  await store.writeText(id, user, "index.html", "<p>hi", null);
  return id;
}

beforeEach(() => {
  writeRoutes([]);
  caddyLoadedIt = false;
});

describe("a publish whose save fails", () => {
  test("keeps the new version, and counts as published, when the address already points at it", async () => {
    save.mode = "persisted-then-threw";
    const id = await newSite();
    const d = await publishSite(user, where, id, { host: "blog.example.test", https: null });
    const live = readRoutes().routes.find((r) => r.id === `site-${id}`);
    expect(live?.type === "subdomain" && live.site?.version).toBe(d.live?.version);
    expect(versionsOnDisk(id)).toEqual([d.live!.version]);
    expect(d).toMatchObject({ state: "live", changes: false });
  });

  test("keeps the new version when Caddy is serving it even though routes.json doesn't say so", async () => {
    save.mode = "rejected";
    caddyLoadedIt = true;
    const id = await newSite();
    await expect(publishSite(user, where, id, { host: "blog.example.test", https: null })).rejects.toThrow("Caddy rejected");
    expect(versionsOnDisk(id)).toHaveLength(1);
  });

  test("removes the new copy when neither routes.json nor Caddy points at it", async () => {
    save.mode = "rejected";
    const id = await newSite();
    await expect(publishSite(user, where, id, { host: "blog.example.test", https: null })).rejects.toThrow("Caddy rejected");
    expect(versionsOnDisk(id)).toEqual([]);
  });
});

describe("a routes.json entry Gluon didn't write", () => {
  test("shows its site as needing a publish instead of breaking the list", async () => {
    const id = await newSite();
    const other = await newSite();
    writeRoutes([
      null,
      "not a route",
      { id: `site-${id}`, type: "subdomain", name: "Blog", enabled: true, host: "blog.example.test", backend: { host: "host.docker.internal", port: 443, tls: false }, site: { id, version: "../../etc" } },
      { id: "odd", type: "subdomain", name: "Odd", enabled: true, site: { id: other, version: "20261025T120000Z" } },
    ]);
    const sites = listSites().sites;
    expect(sites.find((s) => s.id === id)).toMatchObject({ state: "broken", address: { host: "blog.example.test" } });
    expect(sites.find((s) => s.id === other)).toMatchObject({ state: "broken", address: null });
  });

  test("doesn't break search either", async () => {
    const other = await newSite();
    writeRoutes([null, { id: "odd", type: "subdomain", name: "Odd", enabled: true, site: { id: other, version: "nope" } }]);
    await import("./index");
    const { searchAll } = await import("../search");
    const found = await searchAll({ id: "u1", role: "admin", username: "admin" } as never, "blog", { scope: "all", zone: "home", signal: new AbortController().signal } as never);
    const group = (found as { groups: { key: string; items: { id: string; hint?: string }[] }[] }).groups.find((g) => g.key === "sites");
    expect(group?.items.find((i) => i.id === `site:${other}`)).toMatchObject({ hint: "Needs publishing again" });
  });
});
