import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const root = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gluon-grant-")));
});

vi.mock("@/server/host/exec", () => ({
  host: vi.fn(async (_cmd: string, args: string[]) => {
    const p = args[args.length - 1]!;
    const real = fs.realpathSync(path.join(root, p));
    return { stdout: "/" + path.relative(root, real) + "\n" };
  }),
  CommandError: class extends Error {},
}));
vi.mock("@/server/docker/apps", () => ({ getApp: vi.fn(), listApps: vi.fn(), setAppPrefs: vi.fn() }));

const dirs = [
  "srv/media/films",
  "srv/media/music",
  "srv/docker/compose",
  "srv/containerd",
  "srv/dockerfiles",
  "srv/share/bob/.ssh",
  "srv/share/kids",
  "srv/photos/2026/summer",
  "data/stuff",
  "DATA/AppData/x",
  "home/bob/docs",
  "home/alice/.ssh",
  "home/alice/music",
  "etc/ssh",
  "etcetera",
  "tmpfiles",
  "var/log/nginx",
  "var/lib/casaos/apps",
  "var/lib/docker/volumes",
  "tmp/x",
  "opt",
  "mnt/hdd/.gnupg/x",
  "mnt/hdd/media",
  "media",
  "usr/share",
  "proc/1",
  "root",
  ...Array.from({ length: 51 }, (_, i) => `srv/many/d${i}`),
];
for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, "srv/media/file.txt"), "not a folder");
fs.symlinkSync(path.join(root, "etc"), path.join(root, "srv/media/etc-link"));
fs.symlinkSync("films", path.join(root, "srv/media/films-link"));

vi.stubEnv("GLUON_HOST_ROOT", root);
vi.stubEnv("GLUON_DATA", path.join(root, ".gluon-data"));
const { validateGrantPath, createGrant } = await import("./access");
const db = await import("@/server/db");
const addUser = (id: string, name: string, role: "admin" | "member") =>
  db.run(
    "INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at, disabled) VALUES (?, ?, ?, ?, 'x', 0, 0, 0)",
    id,
    id,
    name,
    role,
  );
addUser("ben", "Ben", "member");
addUser("cleo", "Cleo", "member");
addUser("dev", "Dev", "member");
addUser("ada", "Ada", "admin");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

describe("validateGrantPath", () => {
  it.each([
    [" /srv/media/films ", "/srv/media/films"],
    ["/data/stuff/", "/data/stuff"],
    ["/home/bob/docs", "/home/bob/docs"],
    ["/srv//media/./music", "/srv/media/music"],
    ["/srv/media/films-link", "/srv/media/films"],
    ["/etcetera", "/etcetera"],
    ["/srv/dockerfiles", "/srv/dockerfiles"],
    ["/tmpfiles", "/tmpfiles"],
    ["/mnt/hdd/media", "/mnt/hdd/media"],
    ["/home/alice/music", "/home/alice/music"],
    ["/srv/photos", "/srv/photos"],
  ])("accepts %j as %j", async (input, out) => {
    await expect(validateGrantPath(input)).resolves.toBe(out);
  });

  it.each([
    ["srv/x", "invalid"],
    ["", "invalid"],
    ["   ", "invalid"],
    ["/srv/\0x", "invalid"],
    ["/nope", "not_found"],
    ["/srv/media/films/nope", "not_found"],
    ["/srv/media/file.txt", "invalid"],
    ["/", "unsafe"],
    ["/etc", "unsafe"],
    ["/etc/ssh", "unsafe"],
    ["/var/log/nginx", "unsafe"],
    ["/tmp/x", "unsafe"],
    ["/usr/share", "unsafe"],
    ["/proc/1", "unsafe"],
    ["/root", "unsafe"],
    ["/var/lib/casaos/apps", "unsafe"],
    ["/var/lib/docker/volumes", "unsafe"],
    ["/DATA/AppData/x", "unsafe"],
    ["/srv/docker/compose", "unsafe"],
    ["/srv/containerd", "unsafe"],
    ["/home", "unsafe"],
    ["/srv", "unsafe"],
    ["/mnt", "unsafe"],
    ["/media", "unsafe"],
    ["/var", "unsafe"],
    ["/opt", "unsafe"],
    ["/DATA", "unsafe"],
    ["/home/alice/.ssh", "unsafe"],
    ["/mnt/hdd/.gnupg/x", "unsafe"],
    ["/home/alice", "unsafe"],
    ["/srv/share/bob", "unsafe"],
    ["/mnt/hdd", "unsafe"],
  ])("refuses %j as %s", async (input, code) => {
    expect(await refusal(validateGrantPath(input))).toMatchObject({ code, status: 400, details: { field: "path" } });
  });

  it("judges a symlink by where it leads and names that folder", async () => {
    const e = await refusal(validateGrantPath("/srv/media/etc-link"));
    expect(e).toMatchObject({ code: "unsafe", status: 400 });
    expect(e.message).toContain("/etc");
  });

  it("names the key folder or system folder in its sentence", async () => {
    expect((await refusal(validateGrantPath("/DATA"))).message).toContain("/DATA");
    expect((await refusal(validateGrantPath("/var/log/nginx"))).message).toContain("/var/log");
  });

  it("refuses a folder with a key folder deeper below it", async () => {
    expect(await refusal(validateGrantPath("/srv/share"))).toMatchObject({ code: "unsafe", status: 400 });
  });

  it("leaves a sibling of a key folder shareable", async () => {
    await expect(validateGrantPath("/srv/share/kids")).resolves.toBe("/srv/share/kids");
  });
});

describe("createGrant", () => {
  it("refuses unknown people, admins and unsafe paths", async () => {
    expect(await refusal(createGrant({ userId: "ghost", path: "/srv/media/films", access: "read" }))).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await refusal(createGrant({ userId: "ada", path: "/srv/media/films", access: "read" }))).toMatchObject({
      code: "bad_request",
      status: 400,
    });
    expect(await refusal(createGrant({ userId: "ben", path: "/srv/media/etc-link", access: "read" }))).toMatchObject({
      code: "unsafe",
      status: 400,
    });
  });

  it("stores the canonical path with a trimmed label", async () => {
    const g = await createGrant({
      userId: "ben",
      path: " /srv/media/films-link/ ",
      label: "  Films  ",
      access: "write",
    });
    expect(g).toMatchObject({
      userId: "ben",
      userName: "Ben",
      path: "/srv/media/films",
      label: "Films",
      access: "write",
      exists: true,
    });
    expect(g.id).toMatch(/\S/);
    expect(typeof g.createdAt).toBe("number");
    const blank = await createGrant({ userId: "ben", path: "/srv/media/music", label: "   ", access: "read" });
    expect(blank.label).toBeNull();
  });

  it("refuses duplicates and grants already covered by a parent", async () => {
    expect(await refusal(createGrant({ userId: "ben", path: "/srv/media/films/", access: "read" }))).toMatchObject({
      code: "conflict",
      status: 409,
    });
    await createGrant({ userId: "cleo", path: "/srv/photos", access: "write" });
    for (const access of ["read", "write"] as const) {
      expect(await refusal(createGrant({ userId: "cleo", path: "/srv/photos/2026", access }))).toMatchObject({
        code: "conflict",
        status: 409,
      });
    }
  });

  it("lets a write grant upgrade a subfolder of a read-only grant, but not a read one", async () => {
    await createGrant({ userId: "dev", path: "/srv/photos", access: "read" });
    expect(await refusal(createGrant({ userId: "dev", path: "/srv/photos/2026", access: "read" }))).toMatchObject({
      code: "conflict",
    });
    await expect(createGrant({ userId: "dev", path: "/srv/photos/2026", access: "write" })).resolves.toMatchObject({
      path: "/srv/photos/2026",
      access: "write",
    });
    // Another member's grants don't count against dev.
    await expect(
      createGrant({ userId: "ben", path: "/srv/photos/2026/summer", access: "read" }),
    ).resolves.toMatchObject({
      userName: "Ben",
    });
  });

  it("caps a member at 50 grants", async () => {
    addUser("eve", "Eve", "member");
    for (let i = 0; i < 50; i++) await createGrant({ userId: "eve", path: `/srv/many/d${i}`, access: "read" });
    expect(await refusal(createGrant({ userId: "eve", path: "/srv/many/d50", access: "read" }))).toMatchObject({
      code: "conflict",
      status: 409,
    });
  });
});
