import { expect, test } from "vitest";
import { pickEvictions, type CacheFile } from "./icons-cache";

const f = (used: number, size = 10): CacheFile => ({ name: `x${used}.png`, size, mtime: used, used });

test("nothing goes while both caps hold", () => {
  expect(pickEvictions(new Map([["a", f(1)], ["b", f(2)]]), { maxFiles: 2, maxBytes: 100 })).toEqual([]);
});

test("too many files: the least recently used go first, never the one just written", () => {
  const files = new Map([["new", f(0)], ["old", f(1)], ["mid", f(5)], ["hot", f(9)]]);
  expect(pickEvictions(files, { maxFiles: 2, maxBytes: 1e9, keep: "new" })).toEqual(["old", "mid"]);
});

test("too many bytes: evict until the folder fits", () => {
  const files = new Map([["a", f(1, 60)], ["b", f(2, 30)], ["c", f(3, 30)]]);
  expect(pickEvictions(files, { maxFiles: 10, maxBytes: 70 })).toEqual(["a"]);
});
