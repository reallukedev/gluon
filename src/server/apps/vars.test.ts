import { describe, expect, it } from "vitest";
import { envLine, escapeDollars, interpolate, learnVars, parseEnvFile, splitColons, varsIn } from "./vars";

// Deterministic generator so the property checks are reproducible.
function strings(n: number, alphabet: string[], seed = 42) {
  const out: string[] = [];
  let x = seed;
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = Math.floor(rand() * 16);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    out.push(s);
  }
  return out;
}
const TRICKY = [
  "$",
  "$$",
  "{",
  "}",
  "'",
  '"',
  "\\",
  "n",
  "\n",
  "\r\n",
  "#",
  " ",
  "=",
  "a",
  "Z",
  "_",
  "-",
  ":",
  "é",
  "🔑",
  "\t",
];

describe("varsIn", () => {
  it.each<[string, string[]]>([
    ["${A}/x/$B/${A:-d}/$${C}", ["A", "B"]],
    ["no vars, $5 or $", []],
    ["$$HOME and $$$USER", ["USER"]],
    ["${X-a}${Y:+b}${Z+c}${W:?err}${V?err}", ["X", "Y", "Z", "W", "V"]],
    ["$_private/${lower_Case9}", ["_private", "lower_Case9"]],
    ["", []],
  ])("%j -> %j", (s, out) => {
    expect(varsIn(s)).toEqual(out);
  });
});

it("varsIn counts names inside defaults", () => {
  expect(varsIn("${A:-${B}}")).toEqual(["A", "B"]);
});

describe("interpolate", () => {
  it.each<[string, Record<string, string>, string, string[]]>([
    ["$${KEEP} ${X:-def} ${Y-}${Z}", { Z: "z" }, "${KEEP} def z", []],
    ["${A:-${B}}/x", { B: "/srv" }, "/srv/x", []],
    ["${E:-d}|${E-d}", { E: "" }, "d|", []],
    ["${NOPE}/x", {}, "/x", ["NOPE"]],
    ["$HOME/x", { HOME: "/root" }, "/root/x", []],
    ["${A:+alt}|${A+alt}|${B:+alt}|${B+alt}|${C:+alt}", { A: "", B: "b" }, "|alt|alt|alt|", []],
    ["${X}-${X}-$Y", {}, "--", ["X", "X", "Y"]],
    ["${EMPTY}!", { EMPTY: "" }, "!", []],
    ["plain text, no vars: 100%", {}, "plain text, no vars: 100%", []],
    [
      "${APP_DATA_DIR:-./data}/db:/var/lib/postgresql/data",
      { APP_DATA_DIR: "/srv/immich" },
      "/srv/immich/db:/var/lib/postgresql/data",
      [],
    ],
    ["$$$$", {}, "$$", []],
  ])("interpolate(%j)", (s, vars, value, missing) => {
    expect(interpolate(s, vars)).toEqual({ value, missing });
  });

  it("does not report variables with a default as missing", () => {
    expect(interpolate("${A:-x}${B-y}${C:+z}${D+w}", {}).missing).toEqual([]);
  });
});

describe("learnVars", () => {
  it.each<[string, string, Record<string, string> | null]>([
    [
      "${UMBREL_ROOT}/app-data/${APP}/data",
      "/srv/umbrel/app-data/immich/data",
      { UMBREL_ROOT: "/srv/umbrel", APP: "immich" },
    ],
    ["${A}/x/${A}", "/p/x//p", { A: "/p" }],
    ["${A}/x/${A}", "/p/x/q", null],
    ["${A}.d (1)+", "x.d (1)+", { A: "x" }],
    ["${A}.d (1)+", "xyd (1)+", null],
    ["${A}${B}", "abc", null],
    ["/fixed", "/fixed", null],
    ["${A}/data", "/elsewhere/config", null],
    ["$ROOT/media", "/mnt/hdd/media", { ROOT: "/mnt/hdd" }],
    ["${A}/x", "/x", { A: "" }],
    ["pre-${A}-post", "pre-line1\nline2-post", { A: "line1\nline2" }],
    ["${A}[x]*?", "q[x]*?", { A: "q" }],
  ])("learnVars(%j, %j)", (template, actual, out) => {
    expect(learnVars(template, actual)).toEqual(out);
  });
});

describe("escapeDollars", () => {
  it("doubles every dollar", () => {
    expect(escapeDollars("pa$$w0rd$")).toBe("pa$$$$w0rd$$");
    expect(escapeDollars("no dollars")).toBe("no dollars");
  });

  it("survives interpolation for any string", () => {
    for (const s of [...strings(300, TRICKY), "${HOME}", "$HOME", "$$", "${A:-${B}}", "$"]) {
      expect(interpolate(escapeDollars(s), {}).value).toBe(s);
    }
  });
});

describe("parseEnvFile", () => {
  it("reads a realistic .env", () => {
    const text = [
      "# Immich settings",
      "",
      "UPLOAD_LOCATION=/srv/immich/library",
      "  export DB_PASSWORD = 's3cr3t$x'  ",
      "TZ=Europe/Berlin # local zone",
      "COLOR=x#y",
      "EMPTY=",
      "URL=postgres://u:p@db.example.com:5432/app?a=b",
      "   # indented comment",
      "not a valid line",
      "9BAD=1",
      "app.name-with.dots=ok",
      "TZ=UTC",
      'QUOTED="line1\\nline2 \\"q\\" \\\\ end"',
      "SINGLE='$x \\n # y'",
    ].join("\r\n");
    expect(parseEnvFile(text)).toEqual({
      UPLOAD_LOCATION: "/srv/immich/library",
      DB_PASSWORD: "s3cr3t$x",
      TZ: "UTC",
      COLOR: "x#y",
      EMPTY: "",
      URL: "postgres://u:p@db.example.com:5432/app?a=b",
      "app.name-with.dots": "ok",
      QUOTED: 'line1\nline2 "q" \\ end',
      SINGLE: "$x \\n # y",
    });
  });

  it("undoes \\$ inside double quotes", () => {
    expect(parseEnvFile('PRICE="\\$5"').PRICE).toBe("$5");
  });

  it("reads an escaped backslash before n as a backslash and n", () => {
    expect(parseEnvFile('K="a\\\\nb"').K).toBe("a\\nb");
  });

  it("returns nothing for an empty file", () => {
    expect(parseEnvFile("")).toEqual({});
    expect(parseEnvFile("\n\n# only comments\n")).toEqual({});
  });
});

describe("envLine", () => {
  it.each([
    ["a b $c", "K='a b $c'"],
    ["it's $5", 'K="it\'s \\$5"'],
    ["a\nb", 'K="a\\nb"'],
    ["a\r\nb", 'K="a\\nb"'],
    ['say "hi"', "K='say \"hi\"'"],
    ["", "K=''"],
  ])("envLine(K, %j) = %s", (v, line) => {
    expect(envLine("K", v)).toBe(line);
  });

  it.each([
    'say "hi"\nnext',
    "C:\\path\\",
    "plain",
    "",
    "  spaced  ",
    "# not a comment",
    "$$${X}",
    "'",
    '"',
    "\\",
    "line\nbreak's",
  ])("round-trips %j through parseEnvFile", (v) => {
    expect(parseEnvFile(envLine("K", v)).K).toBe(v);
  });

  it.each(["it's $5", "a\\nb'", "it's \\nope"])("round-trips %j through parseEnvFile", (v) => {
    expect(parseEnvFile(envLine("K", v)).K).toBe(v);
  });

  it("round-trips arbitrary single-quotable values", () => {
    const pool = TRICKY.filter((c) => !["'", "\n", "\r\n"].includes(c));
    for (const v of strings(400, pool, 7)) {
      expect(parseEnvFile(envLine("SECRET", v)).SECRET).toBe(v);
    }
  });

  it("round-trips arbitrary values", () => {
    for (const v of strings(
      400,
      TRICKY.filter((c) => c !== "\r\n"),
      7,
    )) {
      expect(parseEnvFile(envLine("SECRET", v)).SECRET).toBe(v);
    }
  });
});

describe("splitColons", () => {
  it.each<[string, string[]]>([
    ["${A:-/x}:/data:ro", ["${A:-/x}", "/data", "ro"]],
    ["/a:/b", ["/a", "/b"]],
    ["/a", ["/a"]],
    ["", [""]],
    ["a::b", ["a", "", "b"]],
    ["${A:-${B:-/x}}:/d", ["${A:-${B:-/x}}", "/d"]],
    ["$ROOT/data:/data:rw,z", ["$ROOT/data", "/data", "rw,z"]],
    ["/srv/a:", ["/srv/a", ""]],
  ])("%j -> %j", (s, out) => {
    expect(splitColons(s)).toEqual(out);
  });
});
