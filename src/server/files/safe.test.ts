import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Files reads the host through GLUON_HOST_ROOT; point it at a scratch tree before the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-safe-"));
vi.stubEnv("GLUON_HOST_ROOT", root);
vi.stubEnv("GLUON_DATA", path.join(root, ".data"));
const { Changed, inDir, mkdirs, openDir, openFileIn } = await import("./safe");
const { settle } = await import("./extract");

const host = (p: string) => path.join(root, p);
const linux = process.platform === "linux";

beforeAll(() => {
  fs.mkdirSync(host("share/photos"), { recursive: true });
  fs.mkdirSync(host("etc"), { recursive: true });
  fs.writeFileSync(host("etc/shadow"), "secret");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("openDir", () => {
  it("refuses a path where a folder has been swapped for a link", async () => {
    fs.mkdirSync(host("share/swapped"), { recursive: true });
    fs.rmSync(host("share/swapped"), { recursive: true });
    fs.symlinkSync("/etc", host("share/swapped"));
    await expect(openDir("/share/swapped")).rejects.toBeInstanceOf(Changed);
  });

  it("refuses a different folder under the same name than the one that was checked", async () => {
    fs.mkdirSync(host("share/albums"));
    const checked = fs.lstatSync(host("share/albums"));
    fs.renameSync(host("share/albums"), host("share/albums-old"));
    fs.mkdirSync(host("share/albums"));
    await expect(openDir("/share/albums", checked)).rejects.toBeInstanceOf(Changed);
    await expect(inDir("/share/albums", fs.lstatSync(host("share/albums")), async () => "ok")).resolves.toBe("ok");
  });

  it.runIf(linux)("keeps writing into the folder it opened after its path is swapped for a link", async () => {
    fs.mkdirSync(host("share/inbox"));
    const dir = await openDir("/share/inbox");
    try {
      // Someone with write access elsewhere swaps the folder for a link to the system's /etc.
      fs.renameSync(host("share/inbox"), host("share/inbox-moved"));
      fs.symlinkSync(host("etc"), host("share/inbox"));
      fs.writeFileSync(dir.at("upload.txt"), "hello");
    } finally {
      await dir.close();
    }
    expect(fs.existsSync(host("share/inbox-moved/upload.txt"))).toBe(true);
    expect(fs.existsSync(host("etc/upload.txt"))).toBe(false);
  });

  it("never names anything but a direct child", async () => {
    await inDir("/share", null, async (d) => {
      expect(() => d.at("../etc")).toThrow();
      expect(() => d.at("a/b")).toThrow();
    });
  });
});

describe("openFileIn", () => {
  it("won't open a link in a file's place, or a different file than the one checked", async () => {
    fs.writeFileSync(host("share/photos/a.jpg"), "a");
    fs.symlinkSync(host("etc/shadow"), host("share/photos/b.jpg"));
    await inDir("/share/photos", null, async (d) => {
      await expect(openFileIn(d, "b.jpg", fs.constants.O_RDONLY)).rejects.toBeInstanceOf(Changed);
      const other = fs.lstatSync(host("etc/shadow"));
      await expect(openFileIn(d, "a.jpg", fs.constants.O_RDONLY, undefined, other)).rejects.toBeInstanceOf(Changed);
      const fh = await openFileIn(d, "a.jpg", fs.constants.O_RDONLY, undefined, fs.lstatSync(host("share/photos/a.jpg")));
      await fh.close();
    });
  });
});

describe("mkdirs", () => {
  it("makes the missing folders one inside the other", async () => {
    expect(await mkdirs("/share/new/a/b")).toEqual(["/share/new", "/share/new/a", "/share/new/a/b"]);
    expect(fs.statSync(host("share/new/a/b")).isDirectory()).toBe(true);
  });
  it("won't make them through a link", async () => {
    fs.symlinkSync(host("etc"), host("share/out"));
    await expect(mkdirs("/share/out/x")).rejects.toBeInstanceOf(Changed);
    expect(fs.existsSync(host("etc/x"))).toBe(false);
  });
});

describe("settle (after extracting)", () => {
  const member = { admin: false, roots: [{ id: "g", label: "share", path: "/share", real: "/share", access: "write" as const, missing: false }] };
  const ctx = { check() {}, progress() {} } as unknown as Parameters<typeof settle>[6];

  it("drops links a member's archive made that point outside their folders, and keeps the rest", async () => {
    fs.mkdirSync(host("share/.gluon-extract-1/Album"), { recursive: true });
    fs.writeFileSync(host("share/.gluon-extract-1/Album/one.jpg"), "1");
    fs.symlinkSync("/etc/shadow", host("share/.gluon-extract-1/Album/abs"));
    fs.symlinkSync("../../../etc", host("share/.gluon-extract-1/Album/up"));
    fs.symlinkSync("one.jpg", host("share/.gluon-extract-1/Album/same"));
    const dropped = await settle("/share/.gluon-extract-1", "Album", "/share/Album", process.getuid?.() ?? 0, process.getgid?.() ?? 0, member, ctx);
    expect(dropped).toBe(2);
    expect(fs.readdirSync(host("share/.gluon-extract-1/Album")).sort()).toEqual(["one.jpg", "same"]);
  });

  it("leaves an admin's links alone", async () => {
    fs.mkdirSync(host("share/.gluon-extract-2"), { recursive: true });
    fs.symlinkSync("/etc", host("share/.gluon-extract-2/etc"));
    const admin = { admin: true, roots: [{ id: "root", label: "Computer", path: "/", real: "/", access: "write" as const, missing: false }] };
    expect(await settle("/share/.gluon-extract-2", "", "/share/x", process.getuid?.() ?? 0, process.getgid?.() ?? 0, admin, ctx)).toBe(0);
  });
});
