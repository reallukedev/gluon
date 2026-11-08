import { describe, expect, it } from "vitest";
import { type BindUse, inside, isBroadPath, norm, relativeTo, resolveFrom, slugify, usersOf, within } from "./paths";

describe("norm", () => {
  it.each<[unknown, string | null]>([
    ["/a//b/", "/a/b"],
    ["/a/../b", "/b"],
    ["/", "/"],
    ["/../..", "/"],
    ["/srv/Fotos 📷/", "/srv/Fotos 📷"],
    ["a/b", null],
    ["./x", null],
    ["", null],
    ["~/x", null],
    ["/a\0b", null],
    [42, null],
    [undefined, null],
  ])("%j -> %j", (p, out) => {
    expect(norm(p as string)).toBe(out);
  });
});

describe("within / inside", () => {
  it.each([
    ["/srv/app/data", "/srv/app", true],
    ["/srv/app", "/srv/app", true],
    ["/srv/app/", "/srv/app", true],
    ["/srv/app2", "/srv/app", false],
    ["/anything", "/", true],
    ["rel", "/", false],
    ["/srv/app", "rel", false],
    ["/srv/app/../other", "/srv/app", false],
    ["/srv/app\0", "/srv", false],
  ])("within(%j, %j) = %s", (c, p, out) => {
    expect(within(c, p)).toBe(out);
  });

  it.each([
    ["/srv/app", "/srv/app", false],
    ["/srv/app/x", "/srv/app/", true],
    ["/srv/app/", "/srv/app", false],
    ["/srv/apps", "/srv/app", false],
    ["/x", "/", true],
    ["/", "/", false],
  ])("inside(%j, %j) = %s", (c, p, out) => {
    expect(inside(c, p)).toBe(out);
  });
});

describe("isBroadPath", () => {
  it.each([
    "relative/dir",
    "",
    "/a\0b",
    "/",
    "/srv",
    "/data",
    "/foo",
    "/home",
    "/var/lib",
    "/usr",
    "/DATA/AppData",
    "/var/lib/docker",
    "/var/lib/docker/volumes",
    "/var/lib/casaos",
    "/var/lib/casaos/apps",
    "/srv/umbrel",
    "/srv/umbrel/app-data",
    "/srv/umbrel/home",
    "/home/umbrel/umbrel",
    "/home/umbrel/umbrel/app-data",
    "/umbrel/app-data",
    "/home/alice",
    "/mnt/hdd",
    "/media/usb",
    "/run/media",
    "/srv/gluon-apps",
    "/mnt/hdd/gluon-apps",
    "/home/alice/projects/gluon-apps",
    "/opt/gluon",
    "/opt/gluon/apps",
    "/mnt/hdd/",
    "/srv/x/..",
    "/srv/immich/../../var/lib",
  ])("treats %j as broad", (p) => {
    expect(isBroadPath(p)).toBe(true);
  });

  it.each([
    "/srv/immich",
    "/srv/umbrel/app-data/immich",
    "/DATA/AppData/jellyfin",
    "/mnt/hdd/media",
    "/home/alice/apps/nextcloud",
    "/opt/gluon/apps/immich",
    "/var/lib/docker/volumes/x_data",
    "/srv/gluon-apps/immich",
    "/opt/nextcloud",
    "/data/AppData",
  ])("treats %j as app-specific", (p) => {
    expect(isBroadPath(p)).toBe(false);
  });
});

describe("resolveFrom", () => {
  it.each<[string, string | null, string | null]>([
    ["~/x", "/opt/app", null],
    ["~", "/opt/app", null],
    ["/srv/x/", "/opt/app", "/srv/x"],
    ["/srv/x/", null, "/srv/x"],
    ["./data", "/opt/app", "/opt/app/data"],
    ["data/db", "/opt/app", "/opt/app/data/db"],
    ["../shared", "/opt/app", "/opt/shared"],
    [".", "/opt/app", "/opt/app"],
    ["./data", null, null],
    ["../../../../etc", "/opt/app", "/etc"],
  ])("resolveFrom(%j, %j) = %j", (p, base, out) => {
    expect(resolveFrom(p, base)).toBe(out);
  });
});

describe("relativeTo", () => {
  it.each([
    ["/opt/app", "/opt/app/data/config", "./data/config"],
    ["/opt/app", "/opt/app", "."],
    ["/opt/app", "/opt/other", "./../other"],
    ["/opt/app", "/srv/media", "./../../srv/media"],
  ])("relativeTo(%j, %j) = %j", (dir, p, out) => {
    expect(relativeTo(dir, p)).toBe(out);
  });

  it("round-trips through resolveFrom", () => {
    for (const p of ["/opt/app/data/config", "/opt/other", "/srv/media/films"]) {
      expect(resolveFrom(relativeTo("/opt/app", p), "/opt/app")).toBe(p);
    }
  });
});

describe("slugify", () => {
  it.each([
    ["My App!", "my-app"],
    ["Home Assistant (2)", "home-assistant-2"],
    ["__x__", "x"],
    ["a".repeat(50), "a".repeat(40)],
    [`${"a".repeat(39)} b`, "a".repeat(39)],
    [`${"a".repeat(39)}__b`, "a".repeat(39)],
    ["immich_server", "immich_server"],
    ["Next--Cloud", "next-cloud"],
    ["  spaced   out  ", "spaced-out"],
    ["___", "app"],
    ["", "app"],
    ["!!!", "app"],
    ["-_-", "app"],
  ])("%j -> %j", (s, out) => {
    expect(slugify(s)).toBe(out);
  });

  it("uses the given fallback", () => {
    expect(slugify("", "data")).toBe("data");
    expect(slugify("Ünïcødé", "data")).toMatch(/^([a-z0-9][a-z0-9_-]*|data)$/);
    expect(slugify("日本語", "data")).toMatch(/^([a-z0-9][a-z0-9_-]*|data)$/);
  });

  it("never returns something unsafe", () => {
    for (const s of ["Ünïcødé", "../../etc", "a/b\\c", "x\0y", "🚀 Rocket", "ÆØÅ-æøå 123", ".hidden"]) {
      const out = slugify(s);
      expect(out.length).toBeLessThanOrEqual(40);
      expect(out === "app" || /^[a-z0-9][a-z0-9_-]*$/.test(out)).toBe(true);
      expect(out).not.toMatch(/[-_]$/);
      expect(out).not.toContain("--");
    }
  });
});

describe("usersOf", () => {
  const p = "/srv/umbrel/app-data/immich";
  const binds: BindUse[] = [
    { source: "/srv/umbrel/app-data/immich/library", container: "immich_server" },
    { source: "/srv/umbrel", container: "umbrel" },
    { source: "/", container: "netdata" },
    { source: "/srv/umbrel/app-data/immich2", container: "other" },
    { source: "/srv/umbrel/app-data/immich", container: "backup" },
  ];
  const mine = new Set(["immich_server"]);

  it("matches the spec example", () => {
    expect(usersOf(p, binds, mine)).toEqual(["backup", "umbrel"]);
    expect(usersOf(p, binds, mine, { broadParents: false })).toEqual(["backup"]);
  });

  it("sorts, de-duplicates, skips invalid sources and handles invalid p", () => {
    const more: BindUse[] = [
      ...binds,
      { source: "/srv/umbrel/app-data/immich/upload/", container: "zeta" },
      { source: "/srv/umbrel/app-data/immich/thumbs", container: "backup" },
      { source: "relative/thing", container: "rel" },
      { source: "/srv/umbrel/app-data/immich\0", container: "nul" },
      { source: "/srv/umbrel/app-data/immich/library", container: "alpha" },
    ];
    expect(usersOf(p, more, mine)).toEqual(["alpha", "backup", "umbrel", "zeta"]);
    expect(usersOf("relative", more, mine)).toEqual([]);
    expect(usersOf(`${p}/`, more, new Set())).toEqual(["alpha", "backup", "immich_server", "umbrel", "zeta"]);
  });

  it("keeps a non-broad parent bind even with broadParents off", () => {
    const b: BindUse[] = [
      { source: "/mnt/hdd/media", container: "jellyfin" },
      { source: "/mnt/hdd", container: "samba" },
    ];
    expect(usersOf("/mnt/hdd/media/films", b, new Set())).toEqual(["jellyfin", "samba"]);
    expect(usersOf("/mnt/hdd/media/films", b, new Set(), { broadParents: false })).toEqual(["jellyfin"]);
  });
});
