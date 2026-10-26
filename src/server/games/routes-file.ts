import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * mc-router's routes file: {"default-server": "host:port", "mappings": {"address": "host:port"}}.
 * Gluon edits only those two keys and keeps everything else in the file as it was.
 *
 * How it's written matters. mc-router (1.48) watches the file itself, not its folder, and reloads
 * on a write or create event for it. Replacing the file by rename swaps the inode under the
 * watch: mc-router gets a remove instead of a write and stops watching until it restarts. So the
 * file is rewritten in place, padded so that every step leaves valid JSON (see writeInPlace).
 */

export interface RoutesDoc {
  raw: string;
  /** The whole parsed file, other keys included. */
  data: Record<string, unknown>;
  mappings: [string, string][];
  fallback: string | null;
  rev: string;
  indent: string;
}

export type Parsed = { ok: true; doc: RoutesDoc } | { ok: false; message: string; line: number | null; excerpt: string };

export const revOf = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

function excerptAt(raw: string, line: number | null): string {
  const lines = raw.split("\n");
  if (line === null) return lines.slice(0, 12).join("\n").slice(0, 1200);
  return lines.slice(Math.max(0, line - 4), line + 3).join("\n").slice(0, 1200);
}

/** Where JSON.parse gave up, as a line number (V8 says "line N column M" or "position N"). */
function errorLine(raw: string, msg: string): number | null {
  const lc = msg.match(/line (\d+)/);
  if (lc) return Number(lc[1]);
  const pos = msg.match(/position (\d+)/);
  if (pos) return raw.slice(0, Number(pos[1])).split("\n").length;
  return null;
}

export function parseRoutes(raw: string): Parsed {
  // mc-router can't load an empty file (Go's JSON reader calls it unexpected end of input).
  if (!raw.trim()) return { ok: false, message: "It's empty, and mc-router can't load an empty file.", line: null, excerpt: "" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const line = errorLine(raw, msg);
    return { ok: false, message: `It isn't valid JSON${line ? ` (line ${line})` : ""}.`, line, excerpt: excerptAt(raw, line) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, message: "It should be a JSON object with \"mappings\" in it.", line: null, excerpt: excerptAt(raw, null) };
  const o = data as Record<string, unknown>;
  const m = o.mappings ?? {};
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, message: "\"mappings\" should be an object of addresses and servers.", line: null, excerpt: excerptAt(raw, null) };
  const mappings = Object.entries(m as Record<string, unknown>);
  const bad = mappings.find(([, v]) => typeof v !== "string");
  if (bad) return { ok: false, message: `The mapping for "${bad[0]}" should be a "host:port" string. mc-router won't load the file like this.`, line: null, excerpt: excerptAt(raw, null) };
  const d = o["default-server"];
  if (d !== undefined && d !== null && typeof d !== "string") return { ok: false, message: "\"default-server\" should be a \"host:port\" string.", line: null, excerpt: excerptAt(raw, null) };
  const indent = raw.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  return { ok: true, doc: { raw, data: o, mappings: mappings as [string, string][], fallback: typeof d === "string" && d.trim() ? d.trim() : null, rev: revOf(raw), indent } };
}

/** A routes file with no addresses, as mc-router can load it. */
export const EMPTY_CONFIG = '{\n  "mappings": {}\n}\n';

/** Where edits start when there's no file yet. */
export function emptyDoc(): RoutesDoc {
  return { raw: "", data: {}, mappings: [], fallback: null, rev: "new", indent: "  " };
}

/**
 * What to write to put an earlier version back. A version from before the file existed comes
 * back as an empty list (writing nothing would leave a file mc-router can't load); anything else
 * must itself be loadable. Null means it can't be put back.
 */
export function restorable(content: string): string | null {
  if (!content.trim()) return EMPTY_CONFIG;
  return parseRoutes(content).ok ? content : null;
}

// ------------------------------------------------------------------ validation

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The address a player types: a host name or an IPv4 address, compared without case (mc-router
 * lowercases both sides). No wildcards: mc-router 1.48 matches names exactly.
 */
export function normalizeHost(input: string): { ok: true; host: string } | { ok: false; message: string } {
  const h = input.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return { ok: false, message: "Enter the address players will type." };
  if (/[:/\s]/.test(h)) return { ok: false, message: "Enter just the address, without a port or https://." };
  if (h.includes("*")) return { ok: false, message: "mc-router matches whole addresses, so wildcards don't work here. Add each address on its own." };
  if (IPV4.test(h)) return { ok: true, host: h };
  if (h.length > 253) return { ok: false, message: "That address is too long." };
  const labels = h.split(".");
  if (!labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return { ok: false, message: "Use letters, numbers, dots and dashes, like survival.mc.example.com." };
  return { ok: true, host: h };
}

/** Where mc-router sends players: host:port, with the host a container name, a host name or an IP. */
export function parseBackend(input: string): { ok: true; host: string; port: number; value: string } | { ok: false; message: string } {
  const s = input.trim();
  const m = s.match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$/i) ?? s.match(/^([^:\s/[\]]+):(\d{1,5})$/);
  if (!m) return { ok: false, message: "Enter the server as host:port, like crafty_container:25566." };
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "The port should be between 1 and 65535." };
  const host = m[1]!;
  if (!s.startsWith("[") && !/^[A-Za-z0-9]([A-Za-z0-9_.-]{0,252})$/.test(host)) return { ok: false, message: "The host should be a container name, a host name or an IP address." };
  return { ok: true, host, port, value: s.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}` };
}

/** The address part of host:port (no brackets). */
export function backendHost(backend: string): string {
  const b = parseBackend(backend);
  return b.ok ? b.host : backend.replace(/:\d+$/, "");
}

export function backendPort(backend: string): number | null {
  const b = parseBackend(backend);
  return b.ok ? b.port : null;
}

// ------------------------------------------------------------------ edits

export type Edit =
  | { kind: "add"; host: string; backend: string }
  | { kind: "update"; host: string; rename?: string; backend?: string }
  | { kind: "remove"; host: string }
  | { kind: "default"; backend: string | null };

export class EditError extends Error {
  constructor(
    message: string,
    public field: string | null = null,
  ) {
    super(message);
  }
}

const same = (a: string, b: string) => a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/** The file's data with one change made. Other keys stay where they were; a renamed address keeps its place. */
export function applyEdit(doc: RoutesDoc, e: Edit): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc.data };
  const entries = doc.mappings.map(([k, v]) => [k, v] as [string, string]);
  const at = (h: string) => entries.findIndex(([k]) => same(k, h));
  if (e.kind === "add") {
    if (at(e.host) >= 0) throw new EditError(`${e.host} is already in mc-router's list. Change that one instead.`, "host");
    entries.push([e.host, e.backend]);
  } else if (e.kind === "update") {
    const i = at(e.host);
    if (i < 0) throw new EditError(`${e.host} isn't in mc-router's list any more.`);
    if (e.rename && !same(e.rename, e.host) && at(e.rename) >= 0) throw new EditError(`${e.rename} is already in mc-router's list.`, "host");
    entries[i] = [e.rename ?? entries[i]![0], e.backend ?? entries[i]![1]];
  } else if (e.kind === "remove") {
    const i = at(e.host);
    if (i < 0) throw new EditError(`${e.host} isn't in mc-router's list any more.`);
    entries.splice(i, 1);
  } else {
    if (e.backend) out["default-server"] = e.backend;
    else delete out["default-server"];
    return out;
  }
  out.mappings = Object.fromEntries(entries);
  return out;
}

export function serialize(data: Record<string, unknown>, indent = "  "): string {
  return JSON.stringify(data, null, indent) + "\n";
}

// ------------------------------------------------------------------ writing

/**
 * Rewrite a file in place (same inode, so watchers on the file keep working) without it ever
 * holding something unreadable: when the new text is shorter, it's first written padded with
 * trailing spaces to the old length (still valid JSON), then the file is trimmed. Creates the
 * file when it's missing, owned like its folder.
 */
export function writeInPlace(file: string, content: string) {
  const next = Buffer.from(content, "utf8");
  let fd: number;
  try {
    fd = fs.openSync(file, "r+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o664);
    try {
      const dir = fs.statSync(path.dirname(file));
      fs.fchownSync(fd, dir.uid, dir.gid);
    } catch {
      /* not ours to change; the default owner works */
    }
  }
  try {
    const old = fs.fstatSync(fd).size;
    const buf = next.length >= old ? next : Buffer.concat([next, Buffer.alloc(old - next.length, 0x20)]);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
    fs.fsyncSync(fd);
    if (buf.length > next.length) {
      fs.ftruncateSync(fd, next.length);
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}
