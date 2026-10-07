import "server-only";
import { formatBytes, formatDuration, formatPercent, formatRelative } from "@/lib/format";
import type { JsonFieldFormat, JsonFieldValue } from "@/lib/widgets-types";

/**
 * JSONPath-lite. Supported:
 *   $.a.b          a.b            (leading "$" optional)
 *   a[0]  a[-1]    array index (negative from the end)
 *   a['key with spaces']  a["x"]
 *   a[*]  a.*      every element / value (results flatten into a list)
 *   …then optionally one trailing function:
 *   .length | .count()   size of a list/string/object
 *   .sum() .avg() .min() .max()   over numbers in a list
 *   .first() .last()   .join()   ", "-joined list
 * No filters, recursion or scripts.
 */

type Seg = { k: "key"; v: string } | { k: "idx"; v: number } | { k: "all" };
type Fn = "length" | "count" | "sum" | "avg" | "min" | "max" | "first" | "last" | "join";
const FNS = new Set<Fn>(["length", "count", "sum", "avg", "min", "max", "first", "last", "join"]);

export interface ParsedPath {
  segs: Seg[];
  fn: Fn | null;
}

export class PathError extends Error {}

export function parsePath(src: string): ParsedPath {
  let s = src.trim();
  if (!s) throw new PathError("The path is empty.");
  if (s.length > 300) throw new PathError("The path is too long.");
  if (s.startsWith("$")) s = s.slice(1);
  const segs: Seg[] = [];
  let fn: Fn | null = null;
  let i = 0;
  const name = /^[A-Za-z_$@\-][\w$@\-]*/;
  while (i < s.length) {
    if (fn) throw new PathError(`Nothing may follow ${fn}.`);
    const c = s[i];
    if (c === ".") {
      i++;
      if (s[i] === "*") {
        segs.push({ k: "all" });
        i++;
        continue;
      }
      const m = name.exec(s.slice(i)) ?? /^\d+/.exec(s.slice(i));
      if (!m) throw new PathError(`Expected a name after “.” at position ${i}.`);
      i += m[0].length;
      if (s.slice(i, i + 2) === "()") {
        if (!FNS.has(m[0] as Fn)) throw new PathError(`Unknown function ${m[0]}().`);
        fn = m[0] as Fn;
        i += 2;
        continue;
      }
      if (m[0] === "length" && i === s.length) {
        fn = "length";
        continue;
      }
      segs.push(/^\d+$/.test(m[0]) ? { k: "idx", v: Number(m[0]) } : { k: "key", v: m[0] });
      continue;
    }
    if (c === "[") {
      const end = s.indexOf("]", i);
      if (end === -1) throw new PathError("A “[” is never closed.");
      const inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === "*") segs.push({ k: "all" });
      else if (/^-?\d+$/.test(inner)) segs.push({ k: "idx", v: Number(inner) });
      else if (/^'.*'$|^".*"$/.test(inner)) segs.push({ k: "key", v: inner.slice(1, -1) });
      else throw new PathError(`Can't read [${inner}]; use [0], [*] or ['name'].`);
      continue;
    }
    if (i === 0) {
      const m = name.exec(s) ?? /^\d+/.exec(s);
      if (!m) throw new PathError("The path should start with a name, “$” or “[”.");
      i += m[0].length;
      segs.push(/^\d+$/.test(m[0]) ? { k: "idx", v: Number(m[0]) } : { k: "key", v: m[0] });
      continue;
    }
    throw new PathError(`Unexpected “${c}” at position ${i}.`);
  }
  return { segs, fn };
}

const MISSING = Symbol("missing");

function step(values: unknown[], seg: Seg, multi: boolean): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (v === null || typeof v !== "object") continue;
    if (seg.k === "all") {
      out.push(...(Array.isArray(v) ? v : Object.values(v)));
    } else if (seg.k === "idx") {
      if (Array.isArray(v)) {
        const idx = seg.v < 0 ? v.length + seg.v : seg.v;
        if (idx >= 0 && idx < v.length) out.push(v[idx]);
      } else if (Object.prototype.hasOwnProperty.call(v, String(seg.v))) out.push((v as Record<string, unknown>)[String(seg.v)]);
    } else if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg.v)) {
      out.push((v as Record<string, unknown>)[seg.v]);
    } else if (Array.isArray(v) && multi) {
      // After a wildcard, keys apply to each element.
      for (const e of v) if (e && typeof e === "object" && !Array.isArray(e) && Object.prototype.hasOwnProperty.call(e, seg.v)) out.push((e as Record<string, unknown>)[seg.v]);
    }
  }
  return out;
}

export function evaluate(doc: unknown, p: ParsedPath): unknown | typeof MISSING {
  let vals: unknown[] = [doc];
  let multi = false;
  for (const seg of p.segs) {
    vals = step(vals, seg, multi);
    if (seg.k === "all") multi = true;
    if (!vals.length) break;
  }
  const result: unknown = multi ? vals : vals.length ? vals[0] : MISSING;
  if (result === MISSING) return p.fn === "count" || p.fn === "length" ? 0 : MISSING;
  if (!p.fn) return result;
  const list = Array.isArray(result) ? result : [result];
  const nums = list.map((x) => (typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN)).filter(Number.isFinite);
  switch (p.fn) {
    case "length":
    case "count":
      if (typeof result === "string") return result.length;
      if (result && typeof result === "object" && !Array.isArray(result)) return Object.keys(result).length;
      return list.length;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : MISSING;
    case "min":
      return nums.length ? Math.min(...nums) : MISSING;
    case "max":
      return nums.length ? Math.max(...nums) : MISSING;
    case "first":
      return list.length ? list[0] : MISSING;
    case "last":
      return list.length ? list[list.length - 1] : MISSING;
    case "join":
      return list.map((x) => (x === null || typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  }
}

function toScalar(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length;
  const s = JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

function asNumber(v: string | number | boolean | null): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function asTime(v: string | number | boolean | null): number | null {
  if (typeof v === "number") return v > 1e11 ? v : v * 1000; // seconds or ms
  if (typeof v === "string") {
    const n = Number(v);
    if (v.trim() && Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function formatValue(v: string | number | boolean | null, format: JsonFieldFormat): string {
  if (v === null) return "No value";
  switch (format) {
    case "number": {
      const n = asNumber(v);
      return n === null ? String(v) : n.toLocaleString("en", { maximumFractionDigits: Math.abs(n) < 10 ? 2 : Math.abs(n) < 1000 ? 1 : 0 });
    }
    case "bytes": {
      const n = asNumber(v);
      return n === null ? String(v) : formatBytes(n);
    }
    case "percent": {
      const n = asNumber(v);
      return n === null ? String(v) : formatPercent(n <= 1 && n >= 0 && !Number.isInteger(n) ? n * 100 : n, 0);
    }
    case "duration": {
      const n = asNumber(v);
      return n === null ? String(v) : formatDuration(n);
    }
    case "date": {
      const t = asTime(v);
      return t === null ? String(v) : new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    }
    case "relative": {
      const t = asTime(v);
      return t === null ? String(v) : formatRelative(t);
    }
    case "boolean":
      return v === true || v === 1 || v === "true" || v === "1" || v === "on" || v === "yes" ? "Yes" : "No";
    default:
      return String(v);
  }
}

export function extractFields(doc: unknown, fields: { label: string; path: string; format: JsonFieldFormat }[]): JsonFieldValue[] {
  return fields.map((f) => {
    let raw: unknown;
    try {
      raw = evaluate(doc, parsePath(f.path));
    } catch {
      raw = MISSING;
    }
    if (raw === MISSING) return { label: f.label, format: f.format, value: null, display: "No value", missing: true };
    const value = toScalar(raw);
    return { label: f.label, format: f.format, value, display: formatValue(value, f.format), missing: false };
  });
}
