import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

// A scratch Caddy folder and a stand-in for Caddy's admin socket.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-caddy-apply-"));
const sock = path.join(dir, "admin.sock");
vi.stubEnv("GLUON_CADDY_DIR", dir);
vi.stubEnv("GLUON_CADDY_SOCKET", sock);

const loads: string[] = [];
let answer = 200;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/load") loads.push(body);
    res.writeHead(answer, { "Content-Type": "application/json" });
    res.end(answer === 200 ? "" : JSON.stringify({ error: "adapting config: bad" }));
  });
});
await new Promise<void>((r) => server.listen(sock, r));
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const { applyConfig, renderCaddyfile } = await import("./routes");
import type { RoutesConfig } from "./routes";

const cfg = (port: number): RoutesConfig => ({
  base_domain: "example.test",
  fallback: { name: "Home", backend: { host: "host.docker.internal", port, tls: false } },
  routes: [],
});
const ROUTES = path.join(dir, "routes.json");
const CADDYFILE = path.join(dir, "Caddyfile");

beforeEach(() => {
  loads.length = 0;
  answer = 200;
  fs.rmSync(`${CADDYFILE}.tmp-${process.pid}`, { recursive: true, force: true });
  fs.writeFileSync(ROUTES, JSON.stringify(cfg(80)));
  fs.writeFileSync(CADDYFILE, renderCaddyfile(cfg(80)));
});

describe("applying public addresses", () => {
  test("saves both files once Caddy takes the change", async () => {
    await applyConfig(cfg(8130), "test");
    expect(loads).toHaveLength(1);
    expect(fs.readFileSync(CADDYFILE, "utf8")).toBe(renderCaddyfile(cfg(8130)));
    expect(JSON.parse(fs.readFileSync(ROUTES, "utf8")).fallback.backend.port).toBe(8130);
  });

  test("when Caddy refuses, nothing on disk changes", async () => {
    answer = 400;
    await expect(applyConfig(cfg(8130), "test")).rejects.toThrow(/Caddy rejected the change/);
    expect(JSON.parse(fs.readFileSync(ROUTES, "utf8")).fallback.backend.port).toBe(80);
  });

  test("when the Caddyfile can't be written, routes.json and Caddy go back to the last saved state", async () => {
    const before = fs.readFileSync(ROUTES, "utf8");
    // Something in the way of the Caddyfile's temporary copy makes that one write fail.
    fs.mkdirSync(`${CADDYFILE}.tmp-${process.pid}`);
    await expect(applyConfig(cfg(8130), "test")).rejects.toThrow(/Nothing changed/);
    expect(fs.readFileSync(ROUTES, "utf8")).toBe(before);
    expect(fs.readFileSync(CADDYFILE, "utf8")).toBe(renderCaddyfile(cfg(80)));
    expect(loads).toEqual([renderCaddyfile(cfg(8130)), renderCaddyfile(cfg(80))]);
  });
});
