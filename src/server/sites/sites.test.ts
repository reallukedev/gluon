import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { makeZip } from "./__fixtures__/zip-writer";

// Drafts live in GLUON_DATA and published versions in GLUON_CADDY_DIR: point both at scratch folders before the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-sites-"));
vi.stubEnv("GLUON_DATA", path.join(root, "data"));
vi.stubEnv("GLUON_CADDY_DIR", path.join(root, "caddy"));
fs.mkdirSync(path.join(root, "caddy"), { recursive: true });
const store = await import("./store");
const { importZip } = await import("./import");
const { copyToVersion, pruneVersions, versionsOnDisk, versionDir } = await import("./versions");
const { signPreview, verifyPreview, servePreview, PREVIEW_TTL_MS } = await import("./preview");
const { SITE_LIMITS } = await import("@/lib/sites-types");

const user = { username: "admin" };
const newSite = (name = "Test") => store.createSiteRow(user, name).id;
const draft = (id: string, rel: string) => path.join(store.draftDir(id), rel);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("importing a zip", () => {
  test.each([
    ["a name that climbs out", "../escape.html"],
    ["a name that climbs out in the middle", "site/../../escape.html"],
    ["an absolute name", "/etc/cron.d/x"],
    ["a Windows drive name", "C:\\Windows\\x"],
    ["a backslash climb", "..\\escape.html"],
  ])("refuses the whole zip when it has %s, and writes nothing", async (_, bad) => {
    const id = newSite();
    const zip = makeZip([{ name: "index.html", data: "<p>ok" }, { name: bad, data: "pwned" }]);
    await expect(importZip(id, user, zip, "")).rejects.toMatchObject({ code: "zip_slip" });
    expect(fs.readdirSync(store.draftDir(id))).toEqual([]);
    expect(fs.existsSync(path.join(root, "data", "escape.html"))).toBe(false);
  });

  test("skips links and hidden files but imports the rest, and says what it skipped", async () => {
    const id = newSite();
    const zip = makeZip([
      { name: "index.html", data: "<p>home" },
      { name: "passwd", data: "/etc/passwd", link: true },
      { name: ".env", data: "SECRET=1" },
      { name: "__MACOSX/._index.html", data: "junk" },
      { name: ".well-known/security.txt", data: "Contact: me" },
    ]);
    const r = await importZip(id, user, zip, "");
    expect(r.added).toBe(2);
    expect(r.skipped.map((s) => s.path).sort()).toEqual([".env", "passwd"]);
    expect(fs.lstatSync(draft(id, "index.html")).isFile()).toBe(true);
    expect(fs.existsSync(draft(id, "passwd"))).toBe(false);
    expect(fs.readFileSync(draft(id, ".well-known/security.txt"), "utf8")).toBe("Contact: me");
  });

  test("uses what's inside a zip that holds one folder, and can unpack into a folder of the site", async () => {
    const id = newSite();
    await importZip(id, user, makeZip([{ name: "my-site/index.html", data: "a" }, { name: "my-site/css/s.css", data: "b" }]), "");
    expect(store.tree(id).files.map((f) => f.path)).toEqual(["css/s.css", "index.html"]);
    await importZip(id, user, makeZip([{ name: "x.html", data: "c" }]), "blog");
    expect(fs.readFileSync(draft(id, "blog/x.html"), "utf8")).toBe("c");
  });

  test("stops an entry that unpacks to more than the zip says, instead of trusting the stated size", async () => {
    const id = newSite();
    const zip = makeZip([{ name: "big.txt", data: "x".repeat(200_000), deflate: true, claimSize: 10 }]);
    await expect(importZip(id, user, zip, "")).rejects.toMatchObject({ code: "bad_zip" });
    expect(fs.existsSync(draft(id, "big.txt"))).toBe(false);
  });

  test("refuses a zip with more files than a site can hold", async () => {
    const id = newSite();
    const zip = makeZip(Array.from({ length: SITE_LIMITS.files + 1 }, (_, i) => ({ name: `f${i}.txt`, data: "" })));
    await expect(importZip(id, user, zip, "")).rejects.toMatchObject({ code: "too_many_files" });
  });

  test("refuses one that says it unpacks to more than a site may hold", async () => {
    const id = newSite();
    const each = SITE_LIMITS.fileBytes;
    const n = Math.ceil(SITE_LIMITS.siteBytes / each) + 1;
    const zip = makeZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.bin`, data: "", claimSize: each })));
    await expect(importZip(id, user, zip, "")).rejects.toMatchObject({ code: "site_too_large" });
  });
});

describe("an import that can't finish", () => {
  const state = (id: string) => ({ rev: store.siteRow(id).draft_rev, files: store.tree(id).files.map((f) => [f.path, fs.readFileSync(draft(id, f.path), "utf8")]) });

  test("is refused before anything changes when a file in the zip would replace a folder in the site", async () => {
    const id = newSite();
    await store.writeText(id, user, "index.html", "old", null);
    await store.writeText(id, user, "img/x.svg", "<svg/>", null);
    const before = state(id);
    await expect(importZip(id, user, makeZip([{ name: "index.html", data: "new" }, { name: "img", data: "a file" }]), "")).rejects.toMatchObject({ status: 409 });
    expect(state(id)).toEqual(before);
  });

  test("is refused before anything changes when the zip itself has a file and a folder with the same name", async () => {
    const id = newSite();
    await store.writeText(id, user, "index.html", "old", null);
    const before = state(id);
    await expect(importZip(id, user, makeZip([{ name: "index.html", data: "new" }, { name: "a", data: "file" }, { name: "a/b.html", data: "page" }]), "")).rejects.toMatchObject({ status: 409 });
    expect(state(id)).toEqual(before);
  });

  // Root ignores folder permissions, so the disk can't be made to refuse a write.
  test.skipIf(process.getuid?.() === 0)("puts back every file it had already replaced when the disk refuses one part-way", async () => {
    const id = newSite();
    await store.writeText(id, user, "index.html", "old", null);
    await store.makeFolder(id, user, "locked");
    const before = state(id);
    fs.chmodSync(draft(id, "locked"), 0o555);
    try {
      await expect(importZip(id, user, makeZip([{ name: "index.html", data: "new" }, { name: "fresh.html", data: "x" }, { name: "locked/page.html", data: "y" }]), "")).rejects.toThrow();
    } finally {
      fs.chmodSync(draft(id, "locked"), 0o755);
    }
    expect(state(id)).toEqual(before);
  });
});

/** Folders on this disk tell "About" and "about" apart (Linux, and Luke's server). */
function caseSensitiveDisk(): boolean {
  const d = fs.mkdtempSync(path.join(root, "case-"));
  fs.writeFileSync(path.join(d, "A"), "");
  const sensitive = !fs.existsSync(path.join(d, "a"));
  fs.rmSync(d, { recursive: true, force: true });
  return sensitive;
}

describe("renaming only the case of a name", () => {
  test("renames the file or folder itself", async () => {
    const id = newSite();
    await store.writeText(id, user, "About.html", "about", null);
    await store.writeText(id, user, "Img/a.svg", "<svg/>", null);
    await store.movePath(id, user, "About.html", "about.html");
    await store.movePath(id, user, "Img", "img");
    expect(store.tree(id).files.map((f) => f.path)).toEqual(["about.html", "img/a.svg"]);
    expect(fs.readdirSync(store.draftDir(id)).sort()).toEqual(["about.html", "img"]);
  });

  test.runIf(caseSensitiveDisk())("never replaces a different file or folder whose name differs only in case", async () => {
    const id = newSite();
    await store.writeText(id, user, "About.html", "big A", null);
    await store.writeText(id, user, "about.html", "small a", null);
    await store.writeText(id, user, "Img/1.svg", "1", null);
    await store.writeText(id, user, "img/2.svg", "2", null);
    await expect(store.movePath(id, user, "About.html", "about.html")).rejects.toMatchObject({ status: 409 });
    await expect(store.movePath(id, user, "Img", "img")).rejects.toMatchObject({ status: 409 });
    expect(store.tree(id).files.map((f) => [f.path, fs.readFileSync(draft(id, f.path), "utf8")])).toEqual([
      ["About.html", "big A"],
      ["Img/1.svg", "1"],
      ["about.html", "small a"],
      ["img/2.svg", "2"],
    ]);
  });
});

describe("saving from the editor", () => {
  test("refuses to overwrite a file that changed since it was opened, and says so", async () => {
    const id = newSite();
    const first = await store.writeText(id, user, "index.html", "one", null);
    await store.writeText(id, user, "index.html", "two (another tab)", first.etag);
    await expect(store.writeText(id, user, "index.html", "three", first.etag)).rejects.toMatchObject({ status: 409, details: { conflict: "changed" } });
    expect(fs.readFileSync(draft(id, "index.html"), "utf8")).toBe("two (another tab)");
  });

  test("won't make a new file over one that's already there", async () => {
    const id = newSite();
    await store.writeText(id, user, "a.html", "a", null);
    await expect(store.writeText(id, user, "a.html", "b", null)).rejects.toMatchObject({ status: 409 });
  });

  test("never reads or writes through a link someone left in the draft", async () => {
    const id = newSite();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(root, draft(id, "up"));
    fs.symlinkSync(outside, draft(id, "page.html"));
    expect(() => store.readFile(id, "up/outside.txt")).toThrow();
    expect(() => store.readFile(id, "page.html")).toThrow();
    await expect(store.writeText(id, user, "up/new.html", "x", null)).rejects.toMatchObject({ code: "bad_path" });
    expect(fs.existsSync(path.join(root, "new.html"))).toBe(false);
    expect(store.tree(id).files).toEqual([]);
  });
});

describe("published versions", () => {
  test("are complete copies readable by any user, keeping each file's modified time", async () => {
    const id = newSite();
    await store.writeText(id, user, "index.html", "<p>hi", null);
    await store.writeText(id, user, "404.html", "nope", null);
    fs.utimesSync(draft(id, "index.html"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const v = copyToVersion(id, store.draftDir(id), "20261025T120000Z");
    expect(v).toMatchObject({ files: 2, own404: true });
    const st = fs.statSync(path.join(versionDir(id, v.version), "index.html"));
    expect(st.mode & 0o777).toBe(0o644);
    expect(Math.floor(st.mtimeMs)).toBe(1_700_000_000_000);
    expect(fs.statSync(versionDir(id, v.version)).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.dirname(versionDir(id, v.version)))).toEqual([v.version]);
  });

  test("pruning keeps the newest few and the live one, even when the live one is old", () => {
    const id = newSite();
    const names = Array.from({ length: 8 }, (_, i) => `2026102${i}T120000Z`);
    for (const n of names) fs.mkdirSync(versionDir(id, n), { recursive: true });
    const gone = pruneVersions(id, 5, [names[0]!]);
    expect(versionsOnDisk(id)).toEqual([names[7], names[6], names[5], names[4], names[0]]);
    expect(gone.sort()).toEqual([names[1], names[2], names[3]]);
  });
});

describe("preview links", () => {
  test("open the site they were made for until they run out", () => {
    const id = newSite();
    const { token } = signPreview(id, "draft", 1_000_000);
    expect(verifyPreview(token, 1_000_000 + 60_000)).toMatchObject({ site: id, target: "draft" });
    expect(verifyPreview(token, 1_000_000 + PREVIEW_TTL_MS + 1000)).toBeNull();
  });

  test("can't be changed to point at another site or version", () => {
    const { token } = signPreview("aaaaaa1111", "draft");
    expect(verifyPreview(token.replace("aaaaaa1111", "bbbbbb2222"))).toBeNull();
    expect(verifyPreview(token.replace(".draft.", ".20261025T120000Z."))).toBeNull();
    const [payload, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    expect(verifyPreview(`${payload}.${sig.replace(/^./, (c) => (c === "0" ? "1" : "0"))}`)).toBeNull();
  });
});

describe("serving a preview", () => {
  let id: string;
  let token: string;
  beforeAll(async () => {
    id = newSite();
    await store.writeText(id, user, "index.html", '<link rel="stylesheet" href="/style.css"><img srcset="/a.png 1x, /b.png 2x"><a href="//cdn.example/x">', null);
    await store.writeText(id, user, "about.html", "about page", null);
    await store.writeText(id, user, "blog/index.html", "blog home", null);
    await store.writeText(id, user, "404.html", "custom not found", null);
    token = signPreview(id, "draft").token;
  });
  const get = (p: string) => servePreview(token, p ? p.split("/") : [], false);

  test("every answer, errors included, runs sandboxed: no origin of its own, only framed by Gluon, never cached", async () => {
    for (const res of [get("index.html"), get("missing"), servePreview("forged", ["index.html"], false)]) {
      expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("answers like the published site: clean URLs, folders, and the site's own 404 page", async () => {
    expect(await get("about").text()).toBe("about page");
    const dir = get("blog");
    expect(dir.status).toBe(307);
    expect(dir.headers.get("location")).toBe(`/api/sites/preview/${token}/blog/index.html`);
    const nf = get("nothing/here");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toBe("custom not found");
  });

  test("points links that start with / at the preview's own root, leaving other sites' links alone", async () => {
    const html = await get("index.html").text();
    const base = `/api/sites/preview/${token}`;
    expect(html).toContain(`href="${base}/style.css"`);
    expect(html).toContain(`srcset="${base}/a.png 1x, ${base}/b.png 2x"`);
    expect(html).toContain('href="//cdn.example/x"');
  });

  test("an expired or forged link gets a page that says so, not the files", async () => {
    const res = servePreview(`${id}.draft.1.${"0".repeat(32)}`, ["index.html"], false);
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain("blog home");
  });
});
