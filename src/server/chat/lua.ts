/**
 * Talking to Prosody through `prosodyctl shell`: Gluon sends one line of Lua and reads back one
 * marked line of JSON. Pure functions only, so they can be tested without a chat server.
 *
 * The console treats a line starting with ">" as raw Lua in Prosody's global environment, prints
 * what it returns as "Result: ...", and reports errors as "! ...". Arguments travel as JSON, never
 * spliced into code, so a name or password can't change what runs. They don't travel in the line
 * itself either: the console keeps every line in a history file in Prosody's data folder, so
 * Gluon leaves them in a private file that the Lua reads and deletes first thing.
 */

/** A Lua long-bracket string whose level never appears in the text: [==[ ... ]==]. */
export function luaLongString(text: string): string {
  let eq = "";
  while (text.includes(`]${eq}]`)) eq += "=";
  // A leading newline is dropped by Lua inside long brackets; JSON never starts with one.
  return `[${eq}[${text}]${eq}]`;
}

/** A double-quoted Lua string, for config files. */
export function luaString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\0/g, "")}"`;
}

/**
 * One console line that runs `body` (Lua statements ending in `return <value>`) with `A` bound to
 * the arguments read from `argsFile` (JSON nulls become nil) and `J` to util.json, then prints
 * `<nonce>:<json>` or `<nonce>!<error>`.
 */
export function rawLine(body: string, argsFile: string, nonce: string): string {
  if (/[\r\n]/.test(body)) throw new Error("Lua body must be one line");
  if (!/^\/tmp\/gluon-[a-f0-9]{16,64}\.json$/.test(argsFile)) throw new Error("Unexpected arguments file");
  return (
    `>local J=require"util.json"; local F=io.open("${argsFile}","rb"); local S=F and F:read("a") or "{}"; if F then F:close() end; os.remove("${argsFile}"); ` +
    `local A=J.decode(S) or {}; for k,v in pairs(A) do if v==J.null then A[k]=nil end end; ` +
    `local ok,r=pcall(function() ${body} end); ` +
    // The console echoes the end of the input line, so the marker is built at run time and never
    // appears whole in what Gluon sent.
    `local M="${nonce.slice(0, 3)}".."${nonce.slice(3)}"; ` +
    `if not ok then return M.."!"..tostring(r) end; return M..":"..J.encode(r==nil and J.null or r)`
  );
}

export type ShellResult = { ok: true; value: unknown } | { ok: false; error: string; fromLua?: boolean };

/** Find the marked result in everything the console printed (banner, prompts and all). */
export function parseShellOutput(out: string, nonce: string): ShellResult {
  // Only a printed result counts ("| Result: <nonce>..."), never an echo of the input.
  const result = out.split(/\r?\n/).find((l) => /^(?:prosody>\s*)?\|?\s*Result:\s*/.test(l) && l.includes(nonce));
  const at = result ? out.indexOf(result) + result.indexOf(nonce) : -1;
  if (at < 0) {
    const bang = out.match(/^(?:prosody> )?\|?\s*!\s*(.+)$/m);
    return { ok: false, error: bang ? bang[1]!.trim() : firstUsefulLine(out) };
  }
  const rest = out.slice(at + nonce.length);
  const end = rest.search(/\r?\n/);
  const line = end < 0 ? rest : rest.slice(0, end);
  if (line.startsWith("!")) return { ok: false, error: cleanLuaError(line.slice(1)), fromLua: true };
  if (!line.startsWith(":")) return { ok: false, error: "Prosody's answer didn't make sense." };
  try {
    return { ok: true, value: JSON.parse(line.slice(1)) };
  } catch {
    return { ok: false, error: "Prosody's answer was cut off." };
  }
}

/** "[string "..."]:1: no such user" → "no such user". */
export function cleanLuaError(text: string): string {
  return text.replace(/^(?:\[string "[^"]*"\]|console|[^:\s]+\.lua):\d+:\s*/, "").trim() || "Prosody reported an error.";
}

function firstUsefulLine(out: string): string {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.replace(/^prosody>\s*\|?\s*/, "").trim())
    .find((l) => l && !/^[*|_\\/ ()-]+$/.test(l) && !/lua-unbound|luarocks|Debian\/Ubuntu|Source \||Old DNS|More help|This package|Welcome to|You may find|prosody\.im\/doc/i.test(l));
  return line ? line.slice(0, 300) : "Prosody didn't answer. Is its admin console (mod_admin_shell) turned on?";
}

/** Lua's json encodes an empty table as {}; callers that expect a list get one. */
export function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
