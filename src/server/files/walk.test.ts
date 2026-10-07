import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineChooser, globToRegExp, probeFindPrintf, walkTree, type WalkHit, type WalkOptions } from "./walk";

let root: string;

function put(rel: string, bytes = 1, ageDays = 0) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(bytes));
  const t = (Date.now() - ageDays * 86_400_000) / 1000;
  fs.utimesSync(f, t, t);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-walk-"));
  put("a.jpg", 10);
  put("notes.md", 5, 30);
  put("Pictures/beach.JPG", 2000);
  put("Pictures/2024/deep/older.png", 10, 400);
  put("Videos/film.mkv", 5000);
  put(".gluon-trash/1/deleted.jpg", 10);
  put("proc/fake.jpg", 10);
  fs.symlinkSync(path.join(root, "Pictures"), path.join(root, "linked"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const base: WalkOptions = { pattern: null, kinds: null, since: 0, depth: 12, limit: 500, timeoutMs: 30_000, skipNames: new Set([".gluon-trash", ".tend-trash"]) };

async function run(o: Partial<WalkOptions>): Promise<{ hits: WalkHit[]; count: number; truncated: boolean; timedOut: boolean }> {
  const hits: WalkHit[] = [];
  const r = await walkTree(root, { ...base, ...o }, (b) => hits.push(...b)).done;
  return { hits, ...r };
}
const rels = (hits: WalkHit[]) => hits.map((h) => h.rel).sort();

describe("walkTree", () => {
  it("matches names case-insensitively and never enters the trash", async () => {
    const { hits } = await run({ pattern: globToRegExp("*.jpg") });
    expect(rels(hits)).toEqual(["Pictures/beach.JPG", "a.jpg", "proc/fake.jpg"]);
  });

  it("doesn't follow links (a linked folder shows up, its contents don't)", async () => {
    const { hits } = await run({});
    expect(hits.find((h) => h.rel === "linked")?.type).toBe("symlink");
    expect(hits.some((h) => h.rel.startsWith("linked/"))).toBe(false);
  });

  it("stops at the depth limit", async () => {
    const { hits } = await run({ depth: 2 });
    expect(hits.some((h) => h.rel === "Pictures/2024")).toBe(true);
    expect(hits.some((h) => h.rel.startsWith("Pictures/2024/"))).toBe(false);
  });

  it("stops at the count limit and says so", async () => {
    const r = await run({ limit: 3 });
    expect(r.count).toBe(3);
    expect(r.hits).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("gives up after the time limit", async () => {
    const r = await run({ timeoutMs: 0 });
    expect(r.timedOut).toBe(true);
  });

  it("filters by kind, size and age like the find command", async () => {
    expect(rels((await run({ kinds: new Set(["image"]) })).hits)).toEqual(["Pictures/2024/deep/older.png", "Pictures/beach.JPG", "a.jpg", "proc/fake.jpg"]);
    expect(rels((await run({ minSize: 1000 })).hits)).toEqual(["Pictures/beach.JPG", "Videos/film.mkv"]);
    expect(rels((await run({ type: "file", since: Date.now() - 7 * 86_400_000 })).hits)).not.toContain("notes.md");
    expect(rels((await run({ type: "dir" })).hits)).toEqual(["Pictures", "Pictures/2024", "Pictures/2024/deep", "Videos", "proc"]);
  });

  it("lets the name match a folder on the way when asked", async () => {
    const { hits } = await run({ pattern: globToRegExp("2024"), inPath: true, type: "file" });
    expect(rels(hits)).toEqual(["Pictures/2024/deep/older.png"]);
    expect((await run({ pattern: globToRegExp("2024"), type: "file" })).hits).toEqual([]);
  });

  it("skips the kernel's folders only at the top of the whole computer", async () => {
    const { hits } = await run({ skipAtTop: new Set(["proc"]) });
    expect(hits.some((h) => h.rel.startsWith("proc"))).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("treats plain words as 'contains' and * ? as wildcards", () => {
    expect(globToRegExp("beach").test("My Beach Day.jpg")).toBe(true);
    expect(globToRegExp("*.mkv").test("film.mkv")).toBe(true);
    expect(globToRegExp("*.mkv").test("film.mkv.part")).toBe(false);
    expect(globToRegExp("a+b (1)").test("a+b (1).txt")).toBe(true);
  });
});

describe("engineChooser", () => {
  it("always uses find on Linux, without asking", async () => {
    let asked = false;
    expect(await engineChooser(async () => ((asked = true), false), "linux")()).toBe("find");
    expect(asked).toBe(false);
  });

  it("walks only where find has no -printf, and asks once", async () => {
    let asked = 0;
    const choose = engineChooser(async () => (asked++, false), "darwin");
    expect(await choose()).toBe("walk");
    expect(await choose()).toBe("walk");
    expect(asked).toBe(1);
    expect(await engineChooser(async () => true, "darwin")()).toBe("find");
    expect(await engineChooser(async () => Promise.reject(new Error("no find")), "darwin")()).toBe("walk");
  });

  it("probes with -printf and reads a clean exit as support", async () => {
    const fake = (code: number, stderr = "") => (args: string[]) => {
      expect(args).toContain("-printf");
      const child = new EventEmitter() as ChildProcess;
      const err = new EventEmitter();
      Object.assign(child, { stderr: err, stdout: { resume() {} }, kill() {} });
      setTimeout(() => {
        if (stderr) err.emit("data", Buffer.from(stderr));
        child.emit("close", code);
      }, 0);
      return child;
    };
    expect(await probeFindPrintf(fake(0))()).toBe(true);
    expect(await probeFindPrintf(fake(1, "find: -printf: unknown primary or operator"))()).toBe(false);
  });
});
