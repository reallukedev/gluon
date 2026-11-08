import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-hostpaths-"));
fs.mkdirSync(path.join(root, "etc"), { recursive: true });
fs.mkdirSync(path.join(root, "srv/Fotos 📷"), { recursive: true });
fs.writeFileSync(path.join(root, "etc/hostname"), "nas.example.com\n");
fs.writeFileSync(path.join(root, "srv/Fotos 📷/é.txt"), "café ☕");

vi.stubEnv("GLUON_HOST_ROOT", root);
const H = await import("./paths");

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("normalizeHostPath", () => {
  it.each([
    ["/a//b/", "/a/b"],
    ["/a/./b/../c", "/a/c"],
    ["/../..", "/"],
    ["/", "/"],
    ["//", "/"],
    ["/a/b/", "/a/b"],
    ["/srv/Fotos 📷/é", "/srv/Fotos 📷/é"],
  ])("%j -> %j", (p, out) => {
    expect(H.normalizeHostPath(p)).toBe(out);
  });

  it.each<[unknown]>([[""], ["a/b"], ["./a"], ["~/x"], ["/a\0b"], [123], [null]])("refuses %j", (p) => {
    expect(() => H.normalizeHostPath(p as string)).toThrow("Expected an absolute path");
  });
});

describe("hostPath", () => {
  it("joins the host root and never climbs above it", () => {
    expect(H.HOST_ROOT).toBe(root);
    expect(H.hostPath("/etc/passwd")).toBe(path.join(root, "etc/passwd"));
    expect(path.normalize(H.hostPath("/") + "/")).toBe(path.normalize(root + "/"));
    expect(H.hostPath("/../../etc")).toBe(path.join(root, "etc"));
    expect(H.hostPath("/srv/../../../../etc/shadow")).toBe(path.join(root, "etc/shadow"));
    expect(() => H.hostPath("etc/passwd")).toThrow("Expected an absolute path");
  });
});

describe("host files", () => {
  it("reads host files as UTF-8 and throws when missing", () => {
    expect(H.readHostFile("/etc/hostname")).toBe("nas.example.com\n");
    expect(H.readHostFile("/srv/Fotos 📷/é.txt")).toBe("café ☕");
    expect(H.readHostFile("/srv/../etc/hostname")).toBe("nas.example.com\n");
    expect(() => H.readHostFile("/etc/missing")).toThrow();
  });

  it.each([["/etc/missing"], ["/etc"], ["etc/hostname"], ["/a\0b"]])("falls back for %j", (p) => {
    expect(H.readHostFileOr(p, "fallback")).toBe("fallback");
  });

  it("checks existence without ever throwing", () => {
    expect(H.hostExists("/etc/hostname")).toBe(true);
    expect(H.hostExists("/etc")).toBe(true);
    expect(H.hostExists("/")).toBe(true);
    expect(H.hostExists("/etc/missing")).toBe(false);
    expect(H.hostExists("relative")).toBe(false);
    expect(H.hostExists("/a\0b")).toBe(false);
  });
});

describe("isWithin", () => {
  it.each([
    ["/srv/media/films", "/srv/media", true],
    ["/srv/media", "/srv/media/", true],
    ["/srv/media", "/srv/media", true],
    ["/anything/at/all", "/", true],
    ["/", "/", true],
    ["/srv/media2", "/srv/media", false],
    ["/mnt/hdd20", "/mnt/hdd2", false],
    ["/srv/media/../secret", "/srv/media", false],
    ["/srv/x/../media/a", "/srv/media", true],
    ["/srv", "/srv/media", false],
    ["/SRV/media", "/srv", false],
    ["/srv//media///films/", "/srv/media", true],
    ["/srv/médiá/x", "/srv/médiá", true],
  ])("isWithin(%j, %j) = %s", (child, parent, out) => {
    expect(H.isWithin(child, parent)).toBe(out);
  });

  it.each([
    ["relative/x", "/srv"],
    ["/srv/x", "srv"],
    ["/srv/\0", "/srv"],
  ])("throws for invalid input (%j, %j)", (child, parent) => {
    expect(() => H.isWithin(child, parent)).toThrow("Expected an absolute path");
  });
});

describe("HOST_ROOT", () => {
  it("returns paths unchanged when the host root is /", async () => {
    vi.resetModules();
    vi.stubEnv("GLUON_HOST_ROOT", "/");
    const M = await import("./paths");
    expect(M.HOST_ROOT).toBe("/");
    expect(M.hostPath("/etc//passwd")).toBe("/etc/passwd");
    expect(M.hostPath("/../x")).toBe("/x");
    expect(M.hostPath("/")).toBe("/");
  });

  it("falls back to TEND_HOST_ROOT, then /proc/1/root", async () => {
    vi.resetModules();
    vi.stubEnv("GLUON_HOST_ROOT", undefined);
    vi.stubEnv("TEND_HOST_ROOT", "/tmp/legacy-root");
    expect((await import("./paths")).HOST_ROOT).toBe("/tmp/legacy-root");
    vi.resetModules();
    vi.stubEnv("TEND_HOST_ROOT", undefined);
    expect((await import("./paths")).HOST_ROOT).toBe("/proc/1/root");
  });
});
