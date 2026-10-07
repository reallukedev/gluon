import "server-only";

/**
 * Compose-style variables: ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?error}, $VAR, and $$ for
 * a literal dollar sign.
 */
const TOKEN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

type Part = { lit: string } | { name: string; op: string | null; arg: string };

function parts(s: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ lit: s.slice(last, m.index) });
    if (m[0] === "$$") out.push({ lit: "$" });
    else out.push({ name: (m[1] ?? m[4])!, op: m[2] ?? null, arg: m[3] ?? "" });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ lit: s.slice(last) });
  return out;
}

/** The variable names a string refers to (not counting $$ escapes). */
export function varsIn(s: string): string[] {
  const names = new Set<string>();
  for (const p of parts(s)) if ("name" in p) names.add(p.name);
  return [...names];
}

/** Substitute what's known. `missing` lists names that had no value and no default. */
export function interpolate(s: string, vars: Record<string, string>): { value: string; missing: string[] } {
  const missing: string[] = [];
  let value = "";
  for (const p of parts(s)) {
    if ("lit" in p) {
      value += p.lit;
      continue;
    }
    const v = vars[p.name];
    const set = v !== undefined;
    const nonEmpty = set && v !== "";
    if (p.op === ":-") value += nonEmpty ? v : interpolate(p.arg, vars).value;
    else if (p.op === "-") value += set ? v : interpolate(p.arg, vars).value;
    else if (p.op === ":+") value += nonEmpty ? interpolate(p.arg, vars).value : "";
    else if (p.op === "+") value += set ? interpolate(p.arg, vars).value : "";
    else if (set) value += v;
    else missing.push(p.name);
  }
  return { value, missing };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Work out variable values by lining a template up with what it became, e.g. a compose file's
 * `${APP_DATA_DIR}/data/config` against the container's real mount `/srv/umbrel/app-data/x/data/config`.
 * Returns null when the two don't line up or the template is ambiguous (two variables side by side).
 */
export function learnVars(template: string, actual: string): Record<string, string> | null {
  const ps = parts(template);
  const vars = ps.filter((p): p is Extract<Part, { name: string }> => "name" in p);
  if (!vars.length) return null;
  const seen = new Map<string, number>();
  let re = "^";
  let group = 0;
  let prevVar = false;
  for (const p of ps) {
    if ("lit" in p) {
      re += escapeRe(p.lit);
      prevVar = false;
      continue;
    }
    if (prevVar) return null;
    prevVar = true;
    const at = seen.get(p.name);
    if (at !== undefined) {
      re += `\\${at}`;
      continue;
    }
    group++;
    seen.set(p.name, group);
    re += "(.*?)";
  }
  re += "$";
  const m = new RegExp(re, "s").exec(actual);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [name, g] of seen) out[name] = m[g]!;
  return out;
}

/** Escape a literal value for a compose file, so `$` isn't read as a variable. */
export const escapeDollars = (s: string) => s.replace(/\$/g, "$$$$");

/** A simple `.env` reader: KEY=value lines, optional quotes, # comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out[m[1]!] = v;
  }
  return out;
}

/**
 * One `.env` line compose reads literally: single quotes, or double quotes with \\, \", \n and \$
 * escaped when the value holds a quote or a newline (the same rules as the builder's env files).
 */
export function envLine(k: string, v: string): string {
  if (!v.includes("'") && !/[\r\n]/.test(v)) return `${k}='${v}'`;
  return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\$/g, "\\$")}"`;
}

/** Split a short-syntax volume ("${A:-/x}:/data:ro") on colons outside ${...}. */
export function splitColons(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "$" && s[i + 1] === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    if (ch === ":" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
