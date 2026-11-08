import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, formatDuration, formatPercent, formatRelative } from "@/lib/format";
import { PathError, evaluate, extractFields, formatValue, parsePath } from "./jsonpath";

const doc = {
  a: { b: [1, 2, "3", "x", null], "key with spaces": 7, "0": "zero" },
  items: [{ name: "n1", v: 1 }, { name: "n2", v: 2 }, { other: 1 }],
  s: "hello",
  empty: [],
};

const ev = (path: string, d: unknown = doc) => evaluate(d, parsePath(path));

describe("parsePath", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    [`a.${"b".repeat(300)}`, "too long"],
    ["a..b", "double dot"],
    ["a[", "unclosed bracket"],
    ["a[x]", "bare word in brackets"],
    ["a.foo()", "unknown function"],
    ["a.sum().b", "segment after a function"],
    ["a b", "space"],
    ["1abc", "leading digit name"],
  ])("rejects %j (%s)", (src) => {
    expect(() => parsePath(src)).toThrow(PathError);
  });

  it("says an empty path is empty", () => {
    expect(() => parsePath("  ")).toThrow("The path is empty.");
  });

  it("only treats length as a function when it is last", () => {
    expect(parsePath("a.length").fn).not.toBeNull();
    expect(parsePath("a.length.b").fn).toBeNull();
    expect(ev("a.length.b", { a: { length: { b: 42 } } })).toBe(42);
    expect(parsePath("a.b").fn).toBeNull();
  });
});

describe("evaluate", () => {
  it.each<[string, unknown]>([
    ["$.a.b", [1, 2, "3", "x", null]],
    ["a.b[0]", 1],
    ["a.b[-1]", null],
    ["a.b[-5]", 1],
    ["a['key with spaces']", 7],
    ['a["key with spaces"]', 7],
    ["a.0", "zero"],
    ["a.b.0", 1],
    ["items[*].name", ["n1", "n2"]],
    ["items.*.v.sum()", 3],
    ["a.b.sum()", 6],
    ["a.b.avg()", 2],
    ["a.b.max()", 3],
    ["a.b.min()", 1],
    ["a.b.first()", 1],
    ["a.b.last()", null],
    ["items[*].name.join()", "n1, n2"],
    ["s.length", 5],
    ["s.count()", 5],
    ["a.length", 3],
    ["a.b.length", 5],
    ["missing.count()", 0],
    ["a.nope.length", 0],
    ["empty.sum()", 0],
  ])("%s", (path, expected) => {
    expect(ev(path)).toEqual(expected);
  });

  it("returns the whole document for $", () => {
    expect(ev("$")).toBe(doc);
  });

  it.each([
    "missing",
    "items[5]",
    "a.b[-6]",
    "empty.first()",
    "empty.avg()",
    "empty.min()",
    "empty.max()",
    "a.toString",
    "a.__proto__",
    "s.constructor",
    "s.x",
  ])("reports %s as missing", (path) => {
    expect(typeof ev(path)).toBe("symbol");
  });

  it("JSON-stringifies objects and null when joining", () => {
    expect(ev("xs.join()", { xs: ["a", 1, { k: "v" }, null, true] })).toBe('a, 1, {"k":"v"}, null, true');
  });

  it("indexes arrays and keys objects with a numeric segment, unicode keys included", () => {
    const d = {
      list: ["zéro", "un"],
      map: { "1": "one" },
      ключ: { 名前: "Ünïcødé" },
    };
    expect(ev("list.1", d)).toBe("un");
    expect(ev("map.1", d)).toBe("one");
    expect(ev("$['ключ']['名前']", d)).toBe("Ünïcødé");
  });

  it("walks through wildcards over object values and nested arrays", () => {
    const d = {
      hosts: {
        alpha: { disks: [{ free: 10 }, { free: 5 }] },
        beta: { disks: [{ free: 1 }] },
      },
    };
    expect(ev("hosts.*.disks", d)).toEqual([[{ free: 10 }, { free: 5 }], [{ free: 1 }]]);
    expect(ev("hosts.*.name.count()", d)).toBe(0);
  });
});

describe("formatValue", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["text", "number", "bytes", "percent", "duration", "date", "relative", "boolean"] as const)(
    "shows null as No value for %s",
    (format) => {
      expect(formatValue(null, format)).toBe("No value");
    },
  );

  it.each<[string | number | boolean, string]>([
    [1234.567, "1,235"],
    [3.14159, "3.14"],
    [123.45, "123.5"],
    [1234567, "1,234,567"],
    ["2500.4", "2,500"],
    ["abc", "abc"],
  ])("formats %j as number %j", (v, out) => {
    expect(formatValue(v, "number")).toBe(out);
  });

  it("reads booleans as 1 and 0 for numbers", () => {
    expect(formatValue(true, "number")).toBe(formatValue(1, "number"));
    expect(formatValue(false, "number")).toBe(formatValue(0, "number"));
    expect(formatValue(true, "number")).toMatch(/^1(\.0+)?$/);
  });

  it("formats text, bytes, durations and percentages like @/lib/format", () => {
    expect(formatValue(42, "text")).toBe("42");
    expect(formatValue(false, "text")).toBe("false");
    expect(formatValue(1536, "bytes")).toBe("1.5 kB");
    expect(formatValue(1536, "bytes")).toBe(formatBytes(1536));
    expect(formatValue("1073741824", "bytes")).toBe(formatBytes(1073741824));
    expect(formatValue("lots", "bytes")).toBe("lots");
    expect(formatValue(93784, "duration")).toBe(formatDuration(93784));
    expect(formatValue(0.5, "percent")).toBe("50%");
    expect(formatValue(50, "percent")).toBe("50%");
    expect(formatValue(0, "percent")).toBe("0%");
    expect(formatValue(1, "percent")).toBe(formatPercent(1, 0));
    expect(formatValue(0.125, "percent")).toBe(formatPercent(12.5, 0));
  });

  it.each<[string | number, string]>([
    [1700000000, "2023-11-14 22:13 UTC"],
    [1700000000000, "2023-11-14 22:13 UTC"],
    ["1700000000", "2023-11-14 22:13 UTC"],
    ["2026-11-08T10:00:00Z", "2026-11-08 10:00 UTC"],
    [1e11, "5138-11-16 09:46 UTC"],
    ["next tuesday-ish", "next tuesday-ish"],
  ])("formats %j as date %j", (v, out) => {
    expect(formatValue(v, "date")).toBe(out);
  });

  it("formats relative times from seconds or milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    const twoHoursAgo = Date.parse("2026-11-08T10:00:00Z");
    expect(formatValue(twoHoursAgo / 1000, "relative")).toBe(formatRelative(twoHoursAgo));
    expect(formatValue(twoHoursAgo, "relative")).toBe(formatRelative(twoHoursAgo));
    expect(formatValue(String(twoHoursAgo / 1000), "relative")).toBe(formatRelative(twoHoursAgo));
  });

  it.each<[string | number | boolean, string]>([
    [true, "Yes"],
    [1, "Yes"],
    ["true", "Yes"],
    ["1", "Yes"],
    ["on", "Yes"],
    ["yes", "Yes"],
    [false, "No"],
    [0, "No"],
    [2, "No"],
    ["off", "No"],
    ["", "No"],
  ])("formats %j as boolean %j", (v, out) => {
    expect(formatValue(v, "boolean")).toBe(out);
  });
});

describe("extractFields", () => {
  it("returns one entry per field, flattening arrays and objects and never throwing", () => {
    const big = { notes: "n".repeat(300) };
    const out = extractFields({ ...doc, cfg: { on: true }, big, ratio: 0.42 }, [
      { label: "Greeting", path: "s", format: "text" },
      { label: "Values", path: "a.b", format: "number" },
      { label: "Config", path: "cfg", format: "text" },
      { label: "Big", path: "big", format: "text" },
      { label: "Last", path: "a.b[-1]", format: "number" },
      { label: "Ratio", path: "$.ratio", format: "percent" },
      { label: "Flag", path: "cfg.on", format: "boolean" },
      { label: "Gone", path: "nope.deeper", format: "number" },
      { label: "Broken", path: "bad[", format: "text" },
    ]);
    expect(out.map((f) => f.label)).toEqual([
      "Greeting",
      "Values",
      "Config",
      "Big",
      "Last",
      "Ratio",
      "Flag",
      "Gone",
      "Broken",
    ]);
    expect(out[0]).toEqual({
      label: "Greeting",
      format: "text",
      value: "hello",
      display: "hello",
      missing: false,
    });
    expect(out[1]).toMatchObject({
      value: 5,
      display: formatValue(5, "number"),
      missing: false,
    });
    expect(out[2]).toMatchObject({ value: '{"on":true}', missing: false });
    const bigText = out[3].value as string;
    // The spec doesn't say whether the ellipsis counts toward the 200.
    expect([200, 201]).toContain(bigText.length);
    expect(bigText.endsWith("…")).toBe(true);
    expect(bigText.startsWith('{"notes":"nnn')).toBe(true);
    expect(out[4]).toMatchObject({
      value: null,
      display: "No value",
      missing: false,
    });
    expect(out[5]).toMatchObject({ value: 0.42, display: "42%" });
    expect(out[6]).toMatchObject({ value: true, display: "Yes" });
    for (const f of out.slice(7))
      expect(f).toMatchObject({
        value: null,
        display: "No value",
        missing: true,
      });
  });

  it("keeps an object of exactly 200 characters intact", () => {
    const pad = "p".repeat(200 - '{"k":""}'.length);
    const [f] = extractFields({ o: { k: pad } }, [{ label: "O", path: "o", format: "text" }]);
    expect(f.value).toBe(JSON.stringify({ k: pad }));
  });
});
