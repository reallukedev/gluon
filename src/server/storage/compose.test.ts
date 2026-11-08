import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/docker/client", () => ({ docker: () => ({}) }));
vi.mock("@/server/host/exec", () => ({ host: vi.fn(), CommandError: class extends Error {} }));

const { applyEdits, lineChanges, mentionsPath, movePath, prefixRegex, replacePrefix, scanComposeText, scanEnvText } =
  await import("./compose");

const OLD = "/mnt/hdd2";
const NEW = "/mnt/ssd";

const SAMPLE = [
  "services:",
  "  web:",
  "    image: nginx",
  "    volumes:",
  "      - /mnt/hdd2/www:/usr/share/nginx/html:ro   # site",
  '      - "/mnt/hdd2/conf:/etc/nginx/conf.d"',
  "      - '/mnt/hdd20/other:/x'",
  "      - ${DATA_ROOT:-/mnt/hdd2}/cache:/cache",
  "      - type: bind",
  "        source: /mnt/hdd2/logs",
  "        target: /var/log/nginx",
  "      - /mnt/hdd2",
  '      - "/mnt/hdd2/esc\\u0061ped:/y"',
  "    environment:",
  "      - ROOT=/mnt/hdd2/www",
  "volumes:",
  "  media:",
  "    driver_opts:",
  "      type: none",
  "      o: bind",
  "      device: /mnt/hdd2/media",
  "",
].join("\n");

describe("whole-path matching", () => {
  it.each([
    ["/mnt/hdd2/x", true],
    ["/mnt/hdd2", true],
    ["--data=/mnt/hdd2", true],
    ["(/mnt/hdd2)", true],
    ["src: '/mnt/hdd2/a'", true],
    ['"/mnt/hdd2"', true],
    ["[/mnt/hdd2, /x]", true],
    ["{a:/mnt/hdd2}", true],
    ["a,/mnt/hdd2", true],
    ["\t/mnt/hdd2 ", true],
    ["/mnt/hdd20/x", false],
    ["/mnt/hdd2.bak", false],
    ["x/mnt/hdd2", false],
    ["/srv/mnt/hdd2", false],
    ["/mnt/hdd2-old", false],
    ["", false],
  ])("mentionsPath(%j) = %s", (s, out) => {
    expect(mentionsPath(s, OLD)).toBe(out);
    expect(mentionsPath(s, OLD)).toBe(out);
    expect(mentionsPath(s, OLD)).toBe(out);
  });

  it("treats regex characters in the old path literally", () => {
    expect(mentionsPath("/mnt/myXdisk (1)/a", "/mnt/my.disk (1)")).toBe(false);
    expect(mentionsPath("/mnt/my.disk (1)/a", "/mnt/my.disk (1)")).toBe(true);
    expect(mentionsPath("/mnt/a+b", "/mnt/a+b")).toBe(true);
    expect(mentionsPath("/mnt/aab", "/mnt/a+b")).toBe(false);
  });

  it("replaces every whole occurrence and keeps the rest", () => {
    expect(replacePrefix("/mnt/hdd2/x:/mnt/hdd20/y", OLD, NEW)).toBe("/mnt/ssd/x:/mnt/hdd20/y");
    expect(replacePrefix("a=/mnt/hdd2 b=(/mnt/hdd2/c) d=/mnt/hdd2.bak", OLD, NEW)).toBe(
      "a=/mnt/ssd b=(/mnt/ssd/c) d=/mnt/hdd2.bak",
    );
    expect(replacePrefix("/mnt/hdd2/x", OLD, "/mnt/$x")).toBe("/mnt/$x/x");
    expect(replacePrefix("/mnt/hdd2/x", OLD, "/mnt/$&$1")).toBe("/mnt/$&$1/x");
    expect(replacePrefix("nothing here", OLD, NEW)).toBe("nothing here");
  });

  it("returns a global regex", () => {
    const re = prefixRegex(OLD);
    expect(re).toBeInstanceOf(RegExp);
    expect(re.global).toBe(true);
    expect("/mnt/hdd2/a /mnt/hdd2/b /mnt/hdd20".match(re)?.length).toBe(2);
  });
});

describe("scanComposeText", () => {
  const scan = scanComposeText(SAMPLE, OLD, NEW);
  const after = applyEdits(SAMPLE, scan.edits);

  it("edits only the host side of volume definitions", () => {
    expect(lineChanges(SAMPLE, after)).toEqual([
      {
        line: 5,
        before: "      - /mnt/hdd2/www:/usr/share/nginx/html:ro   # site",
        after: "      - /mnt/ssd/www:/usr/share/nginx/html:ro   # site",
      },
      {
        line: 6,
        before: '      - "/mnt/hdd2/conf:/etc/nginx/conf.d"',
        after: '      - "/mnt/ssd/conf:/etc/nginx/conf.d"',
      },
      {
        line: 8,
        before: "      - ${DATA_ROOT:-/mnt/hdd2}/cache:/cache",
        after: "      - ${DATA_ROOT:-/mnt/ssd}/cache:/cache",
      },
      { line: 10, before: "        source: /mnt/hdd2/logs", after: "        source: /mnt/ssd/logs" },
      { line: 21, before: "      device: /mnt/hdd2/media", after: "      device: /mnt/ssd/media" },
    ]);
    expect(after.length).toBe(SAMPLE.length - 5);
  });

  it("reports what it left alone and what it couldn't edit", () => {
    expect(scan.untouched).toEqual([
      { line: 12, text: "- /mnt/hdd2" },
      { line: 13, text: '- "/mnt/hdd2/esc\\u0061ped:/y"' },
      { line: 15, text: "- ROOT=/mnt/hdd2/www" },
    ]);
    expect(scan.problems).toHaveLength(1);
    expect(scan.problems[0]).toMatch(/13/);
    expect(scan.sourceVars).toEqual(new Set(["DATA_ROOT"]));
    expect(scan.parseError).toBeNull();
  });

  it("produces edits that index into the text and never overlap", () => {
    const sorted = [...scan.edits].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      expect(SAMPLE.slice(e.start, e.end)).toContain(OLD);
      if (i > 0) expect(e.start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });

  it("never edits the container side and picks up $VAR sources", () => {
    const text = [
      "services:",
      "  app:",
      "    image: example/app",
      "    volumes:",
      "      - /data:/mnt/hdd2",
      "      - $MEDIA/films:/mnt/hdd2/films:ro",
      "      - ${A:-/mnt/hdd2}:/x",
      "      - type: bind",
      '        source: "/mnt/hdd2/quoted"',
      "        target: /mnt/hdd2/inside",
      "    command: ['--root', '/mnt/hdd2']",
      "",
    ].join("\n");
    const s = scanComposeText(text, OLD, NEW);
    const out = applyEdits(text, s.edits);
    expect(lineChanges(text, out)).toEqual([
      { line: 7, before: "      - ${A:-/mnt/hdd2}:/x", after: "      - ${A:-/mnt/ssd}:/x" },
      { line: 9, before: '        source: "/mnt/hdd2/quoted"', after: '        source: "/mnt/ssd/quoted"' },
    ]);
    expect(s.sourceVars).toEqual(new Set(["MEDIA", "A"]));
    expect(s.untouched.map((u) => u.line)).toEqual([5, 6, 10, 11]);
  });

  it("skips double-quoted entries when the new path would need escaping", () => {
    const text = 'services:\n  a:\n    volumes:\n      - "/mnt/hdd2/q:/q"\n      - /mnt/hdd2/p:/p\n';
    for (const np of ['/mnt/new"disk', "/mnt/new\\disk"]) {
      const s = scanComposeText(text, OLD, np);
      expect(lineChanges(text, applyEdits(text, s.edits))).toEqual([
        { line: 5, before: "      - /mnt/hdd2/p:/p", after: `      - ${np}/p:/p` },
      ]);
    }
  });

  it("reports invalid YAML and ignores files without services or volumes", () => {
    const bad = scanComposeText("services: [\n", OLD, NEW);
    expect(bad.parseError).toMatch(/\S/);
    expect(bad.edits).toEqual([]);
    const other = scanComposeText("name: notes\npaths:\n  - /mnt/hdd2/a:/b\n", OLD, NEW);
    expect(other.edits).toEqual([]);
    expect(other.parseError).toBeNull();
  });
});

describe("scanEnvText", () => {
  it("rewrites the spec example", () => {
    const text = "DATA=/mnt/hdd2/app\nOTHER=/mnt/hdd2\n";
    const vars = new Set(["DATA"]);
    const s = scanEnvText(text, OLD, "/mnt/new", vars);
    expect(s.edits).toHaveLength(1);
    expect(applyEdits(text, s.edits)).toBe("DATA=/mnt/new/app\nOTHER=/mnt/hdd2\n");
    expect(s.untouched).toEqual([{ line: 2, text: "OTHER=/mnt/hdd2" }]);
    expect(s.sourceVars).toBe(vars);
    expect(s.problems).toEqual([]);
    expect(s.parseError).toBeNull();
  });

  it("handles export, spaces, quotes and comments", () => {
    const text = [
      'DATA="/mnt/hdd2" # x',
      "export MEDIA = '/mnt/hdd2/media'",
      "  CACHE=/mnt/hdd2/cache   # fast disk",
      "BACKUP=/srv/backup/mnt/hdd2",
      "LOGS=/mnt/hdd20/logs",
      "# old: DATA=/mnt/hdd2/app",
      "",
    ].join("\n");
    const s = scanEnvText(text, OLD, "/mnt/new", new Set(["DATA", "MEDIA", "CACHE", "BACKUP", "LOGS"]));
    expect(lineChanges(text, applyEdits(text, s.edits))).toEqual([
      { line: 1, before: 'DATA="/mnt/hdd2" # x', after: 'DATA="/mnt/new" # x' },
      { line: 2, before: "export MEDIA = '/mnt/hdd2/media'", after: "export MEDIA = '/mnt/new/media'" },
      { line: 3, before: "  CACHE=/mnt/hdd2/cache   # fast disk", after: "  CACHE=/mnt/new/cache   # fast disk" },
    ]);
    expect(s.untouched.map((u) => u.line)).toEqual([6]);
  });

  it("lists values that contain the path later on as untouched", () => {
    const text = "DATA=/srv/x:/mnt/hdd2/y\n";
    const s = scanEnvText(text, OLD, "/mnt/new", new Set(["DATA"]));
    expect(s.edits).toEqual([]);
    expect(s.untouched).toEqual([{ line: 1, text: "DATA=/srv/x:/mnt/hdd2/y" }]);
  });
});

describe("applyEdits", () => {
  it("applies edits in any order", () => {
    const edits = [
      { start: 4, end: 6, text: "YZW" },
      { start: 0, end: 1, text: "X" },
    ];
    expect(applyEdits("abcdef", edits)).toBe("XbcdYZW");
    expect(applyEdits("abcdef", [...edits].reverse())).toBe("XbcdYZW");
    expect(applyEdits("abcdef", [])).toBe("abcdef");
    expect(
      applyEdits("abc", [
        { start: 3, end: 3, text: "!" },
        { start: 0, end: 0, text: "¡" },
      ]),
    ).toBe("¡abc!");
  });
});

describe("lineChanges", () => {
  it("diffs by position", () => {
    expect(lineChanges("a\nb\nc", "a\nB\nc")).toEqual([{ line: 2, before: "b", after: "B" }]);
    expect(lineChanges("a\nb", "a\nb")).toEqual([]);
    expect(lineChanges("a", "a\nb")).toEqual([{ line: 2, before: "", after: "b" }]);
    expect(lineChanges("a\nb\nc", "a")).toEqual([
      { line: 2, before: "b", after: "" },
      { line: 3, before: "c", after: "" },
    ]);
  });
});

describe("movePath", () => {
  it.each([
    ["/mnt/hdd2/x/y", "/mnt/ssd/x/y"],
    ["/mnt/hdd2", "/mnt/ssd"],
    ["/mnt/hdd20/x", "/mnt/hdd20/x"],
    ["/srv/mnt/hdd2", "/srv/mnt/hdd2"],
    ["none", "none"],
    ["UUID=1234-ABCD", "UUID=1234-ABCD"],
    ["LABEL=data", "LABEL=data"],
    ["tmpfs", "tmpfs"],
    ["/mnt/hdd2/\0x", "/mnt/hdd2/\0x"],
  ])("movePath(%j)", (p, out) => {
    expect(movePath(p, OLD, NEW)).toBe(out);
  });
});
