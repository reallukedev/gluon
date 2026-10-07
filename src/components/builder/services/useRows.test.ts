import { describe, expect, it } from "vitest";
import { writtenIndex } from "./useRows";

describe("which written row a check is about", () => {
  it("skips half-typed rows, so the file's second port is the third row on screen", () => {
    const rows = [{ ok: true }, { ok: false }, { ok: true }, { ok: true }];
    expect(writtenIndex(rows, (r) => r.ok)).toEqual([0, null, 1, 2]);
  });
});
