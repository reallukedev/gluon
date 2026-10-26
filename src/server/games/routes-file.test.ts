import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdit, emptyDoc, normalizeHost, parseBackend, parseRoutes, restorable, serialize, writeInPlace, type RoutesDoc } from "./routes-file";

// The shape of Luke's file on the server, plus a key Gluon doesn't know about.
const PROD = `{
  "default-server": "crafty_container:25565",
  "mappings": {
    "mc.example.com": "crafty_container:25565",
    "creative.mc.example.com": "crafty_container:25565",
    "realworld.mc.example.com": "crafty_container:25501"
  },
  "x-note": {"kept": true}
}
`;

function doc(raw = PROD): RoutesDoc {
  const p = parseRoutes(raw);
  if (!p.ok) throw new Error(p.message);
  return p.doc;
}

describe("editing the routes file", () => {
  it("adds, renames in place, repoints and removes without touching other keys", () => {
    const d = doc();
    const added = applyEdit(d, { kind: "add", host: "survival.mc.example.com", backend: "crafty_container:25566" });
    expect(Object.keys(added.mappings as object)).toEqual(["mc.example.com", "creative.mc.example.com", "realworld.mc.example.com", "survival.mc.example.com"]);

    const renamed = applyEdit(d, { kind: "update", host: "CREATIVE.mc.example.com", rename: "fun.mc.example.com", backend: "crafty_container:25569" });
    expect(Object.entries(renamed.mappings as object)).toEqual([
      ["mc.example.com", "crafty_container:25565"],
      ["fun.mc.example.com", "crafty_container:25569"],
      ["realworld.mc.example.com", "crafty_container:25501"],
    ]);

    const removed = applyEdit(d, { kind: "remove", host: "mc.example.com" });
    expect(Object.keys(removed.mappings as object)).toEqual(["creative.mc.example.com", "realworld.mc.example.com"]);

    const noDefault = applyEdit(d, { kind: "default", backend: null });
    expect(noDefault).not.toHaveProperty("default-server");

    for (const out of [added, renamed, removed, noDefault]) {
      expect(out["x-note"]).toEqual({ kept: true });
      // mc-router reads it back with the same meaning.
      expect(parseRoutes(serialize(out, d.indent)).ok).toBe(true);
    }
    expect(serialize(added, d.indent)).toContain('\n  "mappings": {\n    "mc.example.com"');
  });

  it("refuses an address that's already there in another case, and edits to ones that are gone", () => {
    const d = doc();
    expect(() => applyEdit(d, { kind: "add", host: "MC.EXAMPLE.COM", backend: "a:1" })).toThrow(/already/);
    expect(() => applyEdit(d, { kind: "update", host: "mc.example.com", rename: "realworld.mc.example.com" })).toThrow(/already/);
    expect(() => applyEdit(d, { kind: "remove", host: "gone.mc.example.com" })).toThrow(/isn't in/);
  });

  it("starts from a missing file", () => {
    const out = applyEdit(emptyDoc(), { kind: "add", host: "mc.example.com", backend: "crafty_container:25565" });
    expect(out).toEqual({ mappings: { "mc.example.com": "crafty_container:25565" } });
  });
});

describe("files mc-router can't read", () => {
  it.each([
    ["", /empty/],
    ["  \n", /empty/],
    ['{\n  "mappings": {\n    "a.example.com": "x:1",\n  }\n}', /isn't valid JSON \(line \d\)/],
    ['{"mappings": {"a.example.com": 25565}}', /"a.example.com" should be a "host:port" string/],
    ['{"mappings": ["a.example.com"]}', /"mappings" should be an object/],
    ['["a.example.com"]', /should be a JSON object/],
    ['{"default-server": 1, "mappings": {}}', /"default-server" should be/],
  ])("%s", (raw, message) => {
    const p = parseRoutes(raw);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.message).toMatch(message);
      if (raw.trim()) expect(p.excerpt.length).toBeGreaterThan(0);
    }
  });
});

describe("putting back an earlier version", () => {
  it("never writes an empty file: a version from before the file existed comes back as an empty list mc-router can load", () => {
    const back = restorable("");
    expect(back).not.toBe("");
    expect(back && parseRoutes(back).ok).toBe(true);
    expect(back && JSON.parse(back)).toEqual({ mappings: {} });
    expect(restorable(PROD)).toBe(PROD);
    expect(restorable("{nope")).toBeNull();
  });
});

describe("addresses and servers", () => {
  it.each([
    ["Survival.MC.example.com.", "survival.mc.example.com"],
    ["192.168.1.230", "192.168.1.230"],
    ["homeserver", "homeserver"],
  ])("accepts %s", (input, host) => expect(normalizeHost(input)).toEqual({ ok: true, host }));

  it.each(["", "*.mc.example.com", "mc.example.com:25565", "https://mc.example.com", "-bad.mc.example.com", "under_score.mc.example.com", "a..b", "mc.homeserver.123"])("rejects %j", (input) => {
    expect(normalizeHost(input).ok).toBe(false);
  });

  it("reads host:port servers", () => {
    expect(parseBackend(" crafty_container:25566 ")).toEqual({ ok: true, host: "crafty_container", port: 25566, value: "crafty_container:25566" });
    expect(parseBackend("[fd00::5]:25565")).toMatchObject({ ok: true, host: "fd00::5", value: "[fd00::5]:25565" });
    for (const bad of ["crafty_container", "crafty_container:0", "crafty_container:70000", "a b:1", ":25565"]) expect(parseBackend(bad).ok).toBe(false);
  });
});

describe("writing in place", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gluon-routes-"));

  it("keeps the same file (mc-router watches the inode) and its permissions, whether the text grows or shrinks", () => {
    const file = path.join(tmp(), "routes.json");
    fs.writeFileSync(file, PROD, { mode: 0o664 });
    fs.chmodSync(file, 0o664);
    const before = fs.statSync(file);
    const longer = serialize(applyEdit(doc(), { kind: "add", host: "survival.mc.example.com", backend: "crafty_container:25566" }));
    writeInPlace(file, longer);
    expect(fs.readFileSync(file, "utf8")).toBe(longer);
    const shorter = '{"mappings": {}}\n';
    writeInPlace(file, shorter);
    const after = fs.statSync(file);
    expect(fs.readFileSync(file, "utf8")).toBe(shorter);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o664);
    expect(after.size).toBe(Buffer.byteLength(shorter));
  });

  it("creates the file when there isn't one", () => {
    const file = path.join(tmp(), "routes.json");
    writeInPlace(file, '{"mappings": {}}\n');
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mappings: {} });
  });
});
