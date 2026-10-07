import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { RoutesConfig } from "../caddy/routes";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-caddy-"));
process.env.GLUON_CADDY_DIR = dir;
const fixtures = path.join(__dirname, "../../../test/fixtures/certs");
const pem = (n: string) => fs.readFileSync(path.join(fixtures, n), "utf8");
const HOST = "chat.example.test";

let stage: typeof import("./own-certs").stageOwnCerts;
beforeAll(async () => {
  // The fixtures are valid from 2026-10-07; long.crt to 2027-01-05, short.crt to 2026-10-17.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  ({ stageOwnCerts: stage } = await import("./own-certs"));
});
afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (enabled = true): RoutesConfig => ({
  base_domain: "example.test",
  fallback: { name: "Home", backend: { host: "host.docker.internal", port: 80, tls: false } },
  routes: [{ id: "chat", type: "subdomain", name: "Chat", enabled, host: HOST, backend: { host: "host.docker.internal", port: 8080, tls: false }, https: { mode: "own" } }],
});
const crtPath = () => path.join(dir, "certs", `${HOST}.crt`);
const keyPath = () => path.join(dir, "certs", `${HOST}.key`);

describe("storing a certificate someone pasted", () => {
  test("refuses to save an address that needs its own certificate when there isn't one", () => {
    expect(() => stage(cfg(), null, {}, null)).toThrow(expect.objectContaining({ details: expect.objectContaining({ field: "https" }) }));
    // Turned off, it isn't in the Caddyfile, so the save can go ahead.
    expect(stage(cfg(false), null, {}, null).changed).toBe(false);
  });

  test("writes the chain readable and the key private to the owner", () => {
    const r = stage(cfg(), null, { [HOST]: { cert: pem("long.crt"), key: pem("long.key") } }, null);
    expect(r.changed).toBe(true);
    expect(fs.readFileSync(crtPath(), "utf8")).toContain("BEGIN CERTIFICATE");
    expect(fs.statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(crtPath()).mode & 0o777).toBe(0o644);
  });

  test("a bad replacement leaves the certificate Caddy serves alone, and rollback restores it after a failed load", () => {
    const before = fs.readFileSync(crtPath(), "utf8");
    expect(() => stage(cfg(), cfg(), { [HOST]: { cert: pem("long.crt"), key: pem("short.key") } }, null)).toThrow(expect.objectContaining({ details: expect.objectContaining({ field: "key" }) }));
    expect(fs.readFileSync(crtPath(), "utf8")).toBe(before);

    const r = stage(cfg(), cfg(), { [HOST]: { cert: pem("short.crt"), key: pem("short.key") } }, null);
    expect(fs.readFileSync(crtPath(), "utf8")).not.toBe(before);
    r.rollback();
    expect(fs.readFileSync(crtPath(), "utf8")).toBe(before);
  });
});
