import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanLuaError, luaLongString, luaString, parseShellOutput, rawLine } from "./lua";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("luaLongString", () => {
  it("picks a bracket level that the text can't close early", () => {
    for (const text of ['{"a":"]]"}', '{"a":"]=]"}', '{"a":"]]]==]"}']) {
      const out = luaLongString(text);
      const eq = out.match(/^\[(=*)\[/)![1]!;
      const close = `]${eq}]`;
      expect(out.endsWith(close)).toBe(true);
      // The closing bracket appears exactly once: at the end.
      expect(out.slice(0, -close.length).includes(close)).toBe(false);
    }
  });
});

describe("luaString", () => {
  it("keeps quotes, backslashes and line breaks inside the string", () => {
    expect(luaString('say "hi"\\\nbye')).toBe('"say \\"hi\\"\\\\\\nbye"');
  });
});

describe("rawLine", () => {
  const file = "/tmp/gluon-0123456789abcdef0123.json";

  it("never sends the whole marker, so the console's echo of the input can't be mistaken for a result", () => {
    const line = rawLine("return 1", file, "GLUONdeadbeef0001");
    expect(line.startsWith(">")).toBe(true);
    expect(line.includes("GLUONdeadbeef0001")).toBe(false);
    expect(/[\r\n]/.test(line)).toBe(false);
  });

  it("carries no arguments itself, because the console keeps a history of every line", () => {
    const line = rawLine("return A.password", file, "GLUONx");
    expect(line).toContain(file);
    expect(line).toMatch(/os\.remove\("\/tmp\/gluon-[a-f0-9]+\.json"\)/);
    expect(line).not.toMatch(/password"\s*:/);
  });

  it("refuses a multi-line body or an arguments path it didn't make", () => {
    expect(() => rawLine("local x=1\nreturn x", file, "GLUONx")).toThrow();
    expect(() => rawLine("return 1", '/tmp/x"); os.execute("id', "GLUONx")).toThrow();
  });
});

// Transcripts captured from Prosody 13's console (prosodyctl shell fed on stdin). Its echo of the
// input line includes the marker, as older versions of Gluon's line did.
describe("parseShellOutput", () => {
  it("reads the printed result, not the echoed input", () => {
    expect(parseShellOutput(fixture("shell-ok.txt"), "GLUONabc123")).toEqual({ ok: true, value: { n: 2, users: ["ali", "luke"] } });
  });

  it("turns a Lua error into the person-readable message, marked as Gluon's own so its words aren't read as a console failure", () => {
    expect(parseShellOutput(fixture("shell-error.txt"), "GLUONabc123")).toEqual({ ok: false, error: "There's already an account called mia@chat.leech.party.", fromLua: true });
  });

  it("reports the console's own complaint when no result was printed", () => {
    const r = parseShellOutput(fixture("shell-syntax.txt"), "GLUONabc123");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/couldn't understand/);
  });

  it("says the answer was cut off rather than returning half a value", () => {
    expect(parseShellOutput('| Result: GLUONx:{"users":["ali"', "GLUONx")).toEqual({ ok: false, error: "Prosody's answer was cut off." });
  });

  it("explains a console that never answered (admin_shell off) instead of showing the banner", () => {
    const r = parseShellOutput("\n**************************\nProsody was unable to find lua-unbound\n**************************\n", "GLUONx");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toMatch(/unbound/);
  });
});

describe("cleanLuaError", () => {
  it("drops the chunk name and line number Lua adds", () => {
    expect(cleanLuaError('[string "console"]:1: no such user')).toBe("no such user");
    expect(cleanLuaError("/usr/lib/prosody/core/usermanager.lua:120: bad host")).toBe("bad host");
  });
});
