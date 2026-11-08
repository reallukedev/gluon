import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/docker/client", () => ({
  docker: () => ({
    info: async () => {
      throw new Error("no docker");
    },
  }),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-paths-"));
const host = (p: string) => path.join(root, p);
const mkdir = (p: string) => fs.mkdirSync(host(p), { recursive: true });
const touch = (p: string, body = "x") => {
  mkdir(path.dirname(p));
  fs.writeFileSync(host(p), body);
};
const link = (p: string, target: string) => {
  mkdir(path.dirname(p));
  fs.symlinkSync(target, host(p));
};

for (const d of [
  "share/photos/2026",
  "share/music",
  "share/musicx",
  "sharex",
  "etc/ssh",
  "srv/media/old",
  "srv/pool/disk1",
  "srv/share/kids",
  "mnt/hdd/x",
  "home/alice/docs",
  "var/lib/dpkg",
  "share/dl/Docs",
  "share/photos/.tend-trash/old",
]) {
  mkdir(d);
}
touch("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nkid:x:1001:1001::/srv/share/kids:/bin/bash\nsvc:x:999:999::/:/usr/sbin/nologin\n");
touch("share/photos/a.jpg");
touch("share/photos/2026/b.jpg");
touch("other/secret", "top secret");
touch("share/dl/song.mp3");
touch("share/dl/song (2).mp3");
touch("share/dl/x.txt");
touch(`share/dl/${"a".repeat(251)}.txt`);
link("share/photos/abs-link", "/etc");
link("share/photos/rel-escape", "../../other/secret");
link("share/photos/year", "2026");
link("share/photos/up", "../../../../../../etc");
link("share/photos/to-trash", ".tend-trash/old");
link("share/loop1", "loop2");
link("share/loop2", "loop1");
link("share/dl/clip.mov", "nowhere");
for (let i = 0; i < 45; i++) link(`share/chain/l${i}`, `l${i + 1}`);
touch("share/chain/l45");
for (let i = 0; i < 10; i++) link(`share/short/l${i}`, `l${i + 1}`);
touch("share/short/l10");
touch(
  "proc/1/mountinfo",
  [
    "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    "36 25 8:17 / /mnt/hdd rw,relatime shared:1 - ext4 /dev/sdb1 rw",
    "37 25 8:33 / /srv/pool/disk1 rw,relatime shared:2 - xfs /dev/sdc1 rw",
    "",
  ].join("\n"),
);

vi.stubEnv("GLUON_HOST_ROOT", root);
vi.stubEnv("GLUON_DATA", host(".gluon-data"));
const P = await import("./paths");
const db = await import("@/server/db");
type Root = import("./paths").Root;
type Scope = import("./paths").Scope;

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const admin = { id: "a1", role: "admin" as const };
const member = { id: "m9", role: "member" as const };
const mkRoot = (id: string, p: string, access: "read" | "write", missing = false): Root => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  path: p,
  real: p,
  access,
  missing,
});
const photos = mkRoot("photos", "/share/photos", "write");
const shareRead = mkRoot("share", "/share", "read");
const memberScope: Scope = { admin: false, roots: [photos, shareRead] };

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}
function thrown(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    return e as { code: string; status: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a throw");
}

describe("cleanPath", () => {
  it.each([
    ["/a//b/", "/a/b"],
    ["/a/../../b", "/b"],
    ["/", "/"],
    ["//", "/"],
    ["/share/./photos/../music/", "/share/music"],
    ["/Fotos 📷/été", "/Fotos 📷/été"],
  ])("normalises %j to %j", (raw, out) => {
    expect(P.cleanPath(raw)).toBe(out);
  });

  it("asks for a path when given nothing usable", () => {
    for (const v of [undefined, null, 42, "", ["/a"]]) {
      expect(thrown(() => P.cleanPath(v))).toMatchObject({
        code: "bad_request",
        status: 400,
        message: "Choose a folder or file.",
      });
    }
  });

  it.each([["rel"], ["./x"], ["/share/a\0b"], [`/${"a".repeat(4096)}`]])("refuses %j", (raw) => {
    expect(thrown(() => P.cleanPath(raw))).toMatchObject({ code: "bad_request", status: 400 });
  });
});

describe("cleanName", () => {
  it.each(["my file (2).mkv", "Fotos 📷", "x".repeat(255), "..hidden", "a.b.c", " leading space"])(
    "accepts %j",
    (n) => {
      expect(P.cleanName(n)).toBe(n);
    },
  );

  it("normalises to NFC", () => {
    expect(P.cleanName("ét́e")).toBe("ét́e".normalize("NFC"));
    expect(P.cleanName("café")).toBe("café");
  });

  it.each([
    ["non-string", 7],
    ["empty", ""],
    ["whitespace", "   "],
    ["dot", "."],
    ["dot dot", ".."],
    ["slash", "a/b"],
    ["NUL", "a\0b"],
    ["newline", "line\nbreak"],
    ["unit separator", "a\u001fb"],
    ["256 bytes", "é".repeat(128)],
    ["trash", ".gluon-trash"],
    ["legacy trash", ".tend-trash"],
  ])("refuses %s", (_, n) => {
    expect(thrown(() => P.cleanName(n))).toMatchObject({
      code: "bad_request",
      status: 400,
      details: { field: "name" },
    });
  });

  it("knows the trash folder names", () => {
    expect(P.TRASH_DIR).toBe(".gluon-trash");
    expect(P.LEGACY_TRASH_DIR).toBe(".tend-trash");
    expect(
      ["", ".gluon-trash", ".tend-trash", ".gluon-trash2", "gluon-trash", ".Gluon-Trash"].map(P.isTrashDirName),
    ).toEqual([false, true, true, false, false, false]);
  });
});

describe("resolveHost", () => {
  it.each([
    ["/share/photos/abs-link", "/etc", true],
    ["/share/photos/rel-escape", "/other/secret", true],
    ["/share/photos/year", "/share/photos/2026", true],
    ["/share/photos/year/b.jpg", "/share/photos/2026/b.jpg", true],
    ["/share/photos/up", "/etc", true],
    ["/share/../share/photos/./a.jpg", "/share/photos/a.jpg", true],
    ["/../../share", "/share", true],
    ["/share/photos/year/new/file.txt", "/share/photos/2026/new/file.txt", false],
    ["/share/photos/abs-link/ssh/new", "/etc/ssh/new", false],
    ["/share/short/l0", "/share/short/l10", true],
  ])("resolves %j to %j", async (p, real, exists) => {
    const r = await P.resolveHost(p);
    expect(r.real).toBe(real);
    expect(r.exists).toBe(exists);
    expect(r.stat === null).toBe(!exists);
  });

  it("resolves / to a directory", async () => {
    const r = await P.resolveHost("/");
    expect(r.real).toBe("/");
    expect(r.exists).toBe(true);
    expect(r.stat?.isDirectory()).toBe(true);
  });

  it("treats a path below a regular file as missing", async () => {
    await expect(P.resolveHost("/share/photos/a.jpg/x")).resolves.toMatchObject({ exists: false, stat: null });
  });

  it("can leave the last link unfollowed while following the ones before it", async () => {
    const last = await P.resolveHost("/share/photos/year", { followLast: false });
    expect(last.real).toBe("/share/photos/year");
    expect(last.stat?.isSymbolicLink()).toBe(true);
    const mid = await P.resolveHost("/share/photos/year/b.jpg", { followLast: false });
    expect(mid.real).toBe("/share/photos/2026/b.jpg");
    expect(mid.stat?.isFile()).toBe(true);
  });

  it.each(["/share/loop1", "/share/loop1/x", "/share/chain/l0"])(
    "refuses link loops and long chains (%s)",
    async (p) => {
      expect(await caught(P.resolveHost(p))).toMatchObject({ code: "bad_request", status: 400 });
    },
  );
});

describe("scopeFor", () => {
  it("gives an admin the whole computer", async () => {
    expect(await P.scopeFor(admin)).toEqual({
      admin: true,
      roots: [{ id: "root", label: "Computer", path: "/", real: "/", access: "write", missing: false }],
    });
  });
});

describe("accessFor / canSee", () => {
  it("prefers write over read, then the deepest root, on whole segments only", () => {
    expect(P.accessFor(memberScope, "/share/photos/x")).toMatchObject({ access: "write", root: { id: "photos" } });
    expect(P.accessFor(memberScope, "/share/photos")).toMatchObject({ access: "write", root: { id: "photos" } });
    expect(P.accessFor(memberScope, "/share/music")).toMatchObject({ access: "read", root: { id: "share" } });
    expect(P.accessFor(memberScope, "/sharex")).toBeNull();
    expect(P.accessFor(memberScope, "/")).toBeNull();

    const music = mkRoot("music", "/share/music", "read");
    expect(P.accessFor({ admin: false, roots: [music] }, "/share/musicx")).toBeNull();
    expect(P.accessFor({ admin: false, roots: [shareRead, music] }, "/share/music/a.flac")?.root.id).toBe("music");
    const shareWrite = mkRoot("sharew", "/share", "write");
    const photosRead = mkRoot("photosr", "/share/photos", "read");
    expect(P.accessFor({ admin: false, roots: [photosRead, shareWrite] }, "/share/photos/x")).toMatchObject({
      access: "write",
      root: { id: "sharew" },
    });
  });

  it("ignores missing roots for members", () => {
    const gone = mkRoot("photos", "/share/photos", "write", true);
    expect(P.accessFor({ admin: false, roots: [gone, shareRead] }, "/share/photos/x")).toMatchObject({
      access: "read",
      root: { id: "share" },
    });
  });

  it("lets admins see everything and members only their roots", async () => {
    const adminScope = await P.scopeFor(admin);
    expect(P.canSee(adminScope, "/etc/ssh")).toBe(true);
    expect(P.canSee(memberScope, "/etc/ssh")).toBe(false);
    expect(P.canSee(memberScope, "/share/music")).toBe(true);
  });
});

describe("authorize", () => {
  it("returns a full target for an admin, even in system folders", async () => {
    const t = await P.authorize(admin, "/etc//ssh/", "write");
    expect(t).toMatchObject({
      path: "/etc/ssh",
      real: "/etc/ssh",
      exists: true,
      access: "write",
      root: { id: "root" },
    });
    expect(t.fsPath).toBe(path.join(root, "/etc/ssh"));
    expect(t.stat?.isDirectory()).toBe(true);
    expect(t.scope.admin).toBe(true);
  });

  it("propagates path errors first", async () => {
    expect(
      await caught(P.authorize(member, "relative/path", "read", { scope: { admin: false, roots: [] } })),
    ).toMatchObject({
      code: "bad_request",
    });
  });

  it("forbids a member with no usable folders", async () => {
    const scope: Scope = { admin: false, roots: [mkRoot("photos", "/share/photos", "write", true)] };
    expect(await caught(P.authorize(member, "/share/photos/a.jpg", "read", { scope }))).toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it.each([
    "/share/photos/abs-link",
    "/share/photos/abs-link/ssh",
    "/share/photos/rel-escape",
    "/share/../other/secret",
    "/other/secret",
    "/share/photos/up",
  ])("keeps a member inside their shares (%s)", async (raw) => {
    expect(await caught(P.authorize(member, raw, "read", { scope: memberScope }))).toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("does not reveal whether something outside the shares exists", async () => {
    const a = await caught(P.authorize(member, "/other/secret", "read", { scope: memberScope }));
    const b = await caught(P.authorize(member, "/other/not-here", "read", { scope: memberScope }));
    expect(a.code).toBe("forbidden");
    expect(b).toMatchObject({ code: a.code, status: a.status, message: a.message });
  });

  it("refuses writes to a read-only share, naming it", async () => {
    const e = await caught(P.authorize(member, "/share/music", "write", { scope: memberScope }));
    expect(e).toMatchObject({ code: "forbidden", status: 403 });
    expect(e.message).toContain("Share");
    await expect(P.authorize(member, "/share/music", "read", { scope: memberScope })).resolves.toMatchObject({
      access: "read",
      root: { id: "share" },
    });
  });

  it("keeps members out of sign-in files in home folders and key folders anywhere", async () => {
    const scope: Scope = { admin: false, roots: [mkRoot("alice", "/home/alice", "write"), mkRoot("kids", "/srv/share/kids", "write"), mkRoot("photos", "/share/photos", "write")] };
    await expect(P.authorize(member, "/home/alice/docs", "write", { scope })).resolves.toMatchObject({ access: "write" });
    for (const raw of ["/home/alice/.bashrc", "/home/alice/.ssh/authorized_keys", "/home/alice/.config/autostart/x.desktop", "/srv/share/kids/.profile", "/share/photos/.ssh/x"]) {
      expect(await caught(P.authorize(member, raw, "write", { scope, mustExist: false }))).toMatchObject({ code: "forbidden", status: 403 });
    }
    // Reading is still fine, and so are dot files below the top of a home folder.
    await expect(P.authorize(member, "/home/alice/.bashrc", "read", { scope, mustExist: false })).resolves.toMatchObject({ access: "write" });
    await expect(P.authorize(member, "/home/alice/docs/.notes", "write", { scope, mustExist: false })).resolves.toBeTruthy();
    const alice = { real: "/home/alice", scope };
    expect(() => P.assertMemberMayCreate(alice, ".ssh")).toThrow(/sign-in keys/);
    expect(() => P.assertMemberMayCreate(alice, ".zshrc")).toThrow(/home folder/);
    expect(() => P.assertMemberMayCreate({ real: "/srv/share/kids", scope }, ".bash_profile")).toThrow(/home folder/);
    expect(() => P.assertMemberMayCreate(alice, "notes.txt")).not.toThrow();
    expect(() => P.assertMemberMayCreate({ real: "/share/photos", scope }, ".hidden")).not.toThrow();
    const admin: Scope = { admin: true, roots: [] };
    expect(() => P.assertMemberMayCreate({ real: "/home/alice", scope: admin }, ".ssh")).not.toThrow();
  });

  it("follows a link that stays inside the share", async () => {
    await expect(
      P.authorize(member, "/share/photos/year/b.jpg", "write", { scope: memberScope }),
    ).resolves.toMatchObject({
      path: "/share/photos/year/b.jpg",
      real: "/share/photos/2026/b.jpg",
      access: "write",
      root: { id: "photos" },
    });
  });

  it("needs the target to exist unless told otherwise", async () => {
    expect(await caught(P.authorize(member, "/share/photos/new.txt", "write", { scope: memberScope }))).toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(
      P.authorize(member, "/share/photos/new.txt", "write", { scope: memberScope, mustExist: false }),
    ).resolves.toMatchObject({ exists: false, stat: null, real: "/share/photos/new.txt" });
  });

  it.each(["/share/photos/.gluon-trash/x.jpg", "/share/photos/.tend-trash/old", "/share/photos/to-trash"])(
    "keeps the trash out of reach (%s)",
    async (raw) => {
      expect(await caught(P.authorize(admin, raw, "read", { mustExist: false }))).toMatchObject({
        code: "in_trash",
        status: 400,
      });
    },
  );

  it("allows the trash when asked", async () => {
    await expect(
      P.authorize(admin, "/share/photos/.tend-trash/old", "read", { allowTrash: true }),
    ).resolves.toMatchObject({
      real: "/share/photos/.tend-trash/old",
    });
  });

  it("passes followLast through", async () => {
    const t = await P.authorize(member, "/share/photos/abs-link", "write", { scope: memberScope, followLast: false });
    expect(t.real).toBe("/share/photos/abs-link");
    expect(t.stat?.isSymbolicLink()).toBe(true);
  });
});

describe("protection", () => {
  it.each([
    "/etc",
    "/etc/ssh",
    "/usr/local/bin",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64/x",
    "/libx32",
    "/boot/grub",
    "/proc/1",
    "/sys/class",
    "/dev/sda",
    "/run/docker.sock",
    "/var/lib/dpkg/status",
    "/var/lib/apt",
    "/var/lib/systemd/timers",
    "/var/lib/docker",
    "/var/lib/docker/volumes/db/_data",
    "/var/lib/containerd/io",
    "/srv/media/.gluon-trash/x",
    "/srv/media/.tend-trash",
  ])("protects %s", async (real) => {
    expect(typeof (await P.protectionReason(real))).toBe("string");
    expect(await caught(P.assertMutable(real))).toMatchObject({ code: "protected", status: 403 });
  });

  it.each([
    "/srv/x",
    "/mnt/hdd/media",
    "/home/alice/docs",
    "/etcetera",
    "/usrdata",
    "/var/lib/dockerish",
    "/var/log",
    "/",
  ])("leaves %s alone", async (real) => {
    expect(await P.protectionReason(real)).toBeNull();
    await expect(P.assertMutable(real)).resolves.toBeUndefined();
  });

  it("names the folder and the verb", async () => {
    const reason = await P.protectionReason("/etc/ssh", "delete");
    expect(reason).toContain("/etc");
    expect(reason).toContain("delete");
    expect((await caught(P.assertMutable("/etc/ssh", "delete"))).message).toBe(reason);
  });

  it("finds protected folders below a path", async () => {
    const below = await P.protectedInside("/var");
    expect(below).toMatch(/^\/var\/lib\//);
    expect(await P.protectedInside("/")).not.toBeNull();
    expect(await P.protectedInside("/srv")).toBeNull();
    expect(await P.protectedInside("/home/alice")).toBeNull();
  });
});

describe("assertRemovable", () => {
  const adminScope: Scope = {
    admin: true,
    roots: [{ id: "root", label: "Computer", path: "/", real: "/", access: "write", missing: false }],
  };
  const asAdmin = (real: string) => ({ real, root: adminScope.roots[0], scope: adminScope });

  it.each([
    "/",
    "/srv",
    "/mnt",
    "/home",
    "/home/alice",
    "/mnt/hdd",
    "/srv/pool",
    "/srv/pool/disk1",
    "/etc/ssh",
    "/var/lib/docker",
  ])("refuses to remove %s", async (real) => {
    expect(await caught(P.assertRemovable(asAdmin(real), "delete"))).toMatchObject({ code: "protected", status: 403 });
  });

  it.each(["/srv/media/old", "/mnt/hdd/x", "/home/alice/docs"])("allows removing %s", async (real) => {
    await expect(P.assertRemovable(asAdmin(real), "delete")).resolves.toBeUndefined();
  });

  it("stops a member removing the top of their own share", async () => {
    expect(
      await caught(P.assertRemovable({ real: "/share/photos", root: photos, scope: memberScope }, "move")),
    ).toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await expect(
      P.assertRemovable({ real: "/share/photos/2026", root: photos, scope: memberScope }, "move"),
    ).resolves.toBeUndefined();
  });

  it("refuses folders shared with a household member with 409", async () => {
    db.run(
      "INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at, disabled) VALUES ('m1','m1','M','member','x',0,0,0)",
    );
    db.run(
      "INSERT INTO file_grants (id, user_id, path, label, access, created_at) VALUES ('g1','m1','/srv/share/kids',NULL,'read',0)",
    );
    for (const real of ["/srv/share", "/srv/share/kids"]) {
      expect(await caught(P.assertRemovable(asAdmin(real), "delete"))).toMatchObject({
        code: "protected",
        status: 409,
      });
    }
    await expect(P.assertRemovable(asAdmin("/srv/media/old"), "delete")).resolves.toBeUndefined();
  });
});

describe("names", () => {
  it.each([
    ["a.tar.gz", "a", ".tar.gz"],
    ["a.b.c", "a.b", ".c"],
    ["photo.JPEG", "photo", ".JPEG"],
    [".bashrc", ".bashrc", ""],
    [".config.json", ".config", ".json"],
    ["noext", "noext", ""],
    ["file.", "file.", ""],
    ["x.verylongextension", "x.verylongextension", ""],
    ["backup.2026.tar.xz", "backup.2026", ".tar.xz"],
    ["clip.mp4", "clip", ".mp4"],
    ["notes.mé", "notes.mé", ""],
  ])("splits %j", (name, stem, ext) => {
    expect(P.splitName(name)).toEqual({ stem, ext });
  });

  it("joins logical children", () => {
    expect(P.logicalChild({ path: "/" }, "x")).toBe("/x");
    expect(P.logicalChild({ path: "/a" }, "x")).toBe("/a/x");
    expect(P.logicalChild({ path: "/share/photos" }, "été 📷.jpg")).toBe("/share/photos/été 📷.jpg");
  });

  it("finds free copy names next to files, folders and dangling links", async () => {
    expect(await P.freeName("/share/dl", "new.mp3")).toBe("new.mp3");
    expect(await P.freeName("/share/dl", "song.mp3")).toBe("song (3).mp3");
    expect(await P.freeName("/share/dl", "Docs")).toBe("Docs (2)");
    expect(await P.freeName("/share/dl", "clip.mov")).toBe("clip (2).mov");
  });

  it("finds free restored names", async () => {
    expect(await P.freeName("/share/dl", "x.txt", "restored")).toBe("x (restored).txt");
    touch("share/dl/x (restored).txt");
    expect(await P.freeName("/share/dl", "x.txt", "restored")).toBe("x (restored 2).txt");
    touch("share/dl/x (restored 2).txt");
    expect(await P.freeName("/share/dl", "x.txt", "restored")).toBe("x (restored 3).txt");
  });

  it("gives up with a conflict when every candidate is too long", async () => {
    expect(await caught(P.freeName("/share/dl", `${"a".repeat(251)}.txt`))).toMatchObject({
      code: "conflict",
      status: 409,
    });
  });
});
