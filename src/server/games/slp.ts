/**
 * Minecraft Java's Server List Ping, the exchange the multiplayer screen does: a handshake that
 * names the address the player typed (which is how mc-router picks a server), a status request,
 * and a JSON reply with the version, the MOTD and who's online. Servers from before 1.7 answer
 * the older "legacy" ping instead, with a 0xFF packet of UTF-16 text. Pure: no sockets here.
 */

export interface SlpStatus {
  version: string | null;
  protocol: number | null;
  motd: string | null;
  online: number | null;
  max: number | null;
  players: string[];
  /** The server's icon as a data: URL, when it sends one. */
  favicon: string | null;
}

/** Packets bigger than this aren't a status reply (vanilla caps the JSON at 32767 characters; modded lists run longer). */
export const MAX_PACKET = 2 * 1024 * 1024;

export function encodeVarInt(n: number): Buffer {
  let v = n >>> 0;
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

/** A VarInt at `offset`: its value and how many bytes it took, or null when the buffer ends first. */
export function decodeVarInt(buf: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i]!;
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value: value | 0, size: i + 1 };
  }
  throw new Error("VarInt is longer than 5 bytes");
}

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([encodeVarInt(b.length), b]);
}

function packet(id: number, body: Buffer): Buffer {
  const inner = Buffer.concat([encodeVarInt(id), body]);
  return Buffer.concat([encodeVarInt(inner.length), inner]);
}

/**
 * Handshake (next state: status) followed by the status request. Protocol -1 is the convention
 * for "just asking", which every server answers whatever its version.
 */
export function encodeStatusRequest(address: string, port: number, protocol = -1): Buffer {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  const handshake = packet(0x00, Buffer.concat([encodeVarInt(protocol), str(address), p, encodeVarInt(1)]));
  return Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]);
}

/** The 1.6 ping (0xFE 0x01 0xFA "MC|PingHost" …), which also carries the address, so mc-router can route it. */
export function encodeLegacyPing(address: string, port: number): Buffer {
  const u16 = (s: string) => {
    const b = Buffer.from(s, "utf16le").swap16();
    const len = Buffer.alloc(2);
    len.writeUInt16BE(s.length);
    return Buffer.concat([len, b]);
  };
  const host = u16(address);
  const rest = Buffer.alloc(5);
  rest.writeUInt32BE(port, 1);
  rest[0] = 74; // protocol 74 is 1.6.2
  const data = Buffer.concat([Buffer.from([rest[0]]), host, rest.subarray(1)]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length);
  return Buffer.concat([Buffer.from([0xfe, 0x01, 0xfa]), u16("MC|PingHost"), len, data]);
}

export type Decoded = { kind: "incomplete" } | { kind: "status"; status: SlpStatus } | { kind: "legacy-kick"; text: string } | { kind: "error"; message: string };

/** Formatting codes (§ and a character) and the odd stray §. */
const CODES = /§[0-9a-fk-orx]?/gi;

export function plain(s: string): string {
  return s
    .replace(CODES, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** A chat component (string, {text, extra}, or a list of them) as plain text. */
export function componentText(c: unknown, depth = 0): string {
  if (depth > 32 || c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map((x) => componentText(x, depth + 1)).join("");
  if (typeof c === "object") {
    const o = c as { text?: unknown; translate?: unknown; extra?: unknown };
    const own = typeof o.text === "string" ? o.text : typeof o.translate === "string" ? o.translate : "";
    return own + (Array.isArray(o.extra) ? componentText(o.extra, depth + 1) : "");
  }
  return "";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function statusFromJson(json: string): SlpStatus {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("the status isn't a JSON object");
  const version = (o.version ?? {}) as { name?: unknown; protocol?: unknown };
  const players = (o.players ?? {}) as { online?: unknown; max?: unknown; sample?: unknown };
  const sample = Array.isArray(players.sample) ? players.sample : [];
  const favicon = typeof o.favicon === "string" && o.favicon.startsWith("data:image/png;base64,") && o.favicon.length < 200_000 ? o.favicon : null;
  return {
    version: typeof version.name === "string" ? plain(version.name) || null : null,
    protocol: num(version.protocol),
    motd: plain(componentText(o.description)) || null,
    online: num(players.online),
    max: num(players.max),
    players: sample
      .map((p) => (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" ? plain((p as { name: string }).name) : ""))
      .filter((n) => n && n !== "Anonymous Player")
      .slice(0, 12),
    favicon,
  };
}

/**
 * The legacy reply's text: "§1\0protocol\0version\0motd\0online\0max" from 1.4 to 1.6, or
 * "motd§online§max" from Beta 1.8 to 1.3.
 */
export function parseLegacyText(text: string): SlpStatus | null {
  if (text.startsWith("§1\0")) {
    const [, protocol, version, motd, online, max] = text.split("\0");
    return { version: version ? plain(version) : null, protocol: Number(protocol) || null, motd: motd ? plain(motd) || null : null, online: Number.isFinite(Number(online)) ? Number(online) : null, max: Number.isFinite(Number(max)) ? Number(max) : null, players: [], favicon: null };
  }
  const parts = text.split("§");
  if (parts.length < 3) return null;
  const max = Number(parts.pop());
  const online = Number(parts.pop());
  if (!Number.isInteger(max) || !Number.isInteger(online)) return null;
  return { version: null, protocol: null, motd: plain(parts.join("§")) || null, online, max, players: [], favicon: null };
}

/** Read whatever has arrived so far: the status reply, a legacy 0xFF packet, or not enough yet. */
export function decodeResponse(buf: Buffer): Decoded {
  if (buf.length === 0) return { kind: "incomplete" };
  if (buf[0] === 0xff) {
    if (buf.length < 3) return { kind: "incomplete" };
    const chars = buf.readUInt16BE(1);
    if (buf.length < 3 + chars * 2) return { kind: "incomplete" };
    return { kind: "legacy-kick", text: Buffer.from(buf.subarray(3, 3 + chars * 2)).swap16().toString("utf16le") };
  }
  try {
    const len = decodeVarInt(buf, 0);
    if (!len) return { kind: "incomplete" };
    if (len.value <= 0 || len.value > MAX_PACKET) return { kind: "error", message: "the reply isn't a Minecraft status" };
    if (buf.length < len.size + len.value) return { kind: "incomplete" };
    const body = buf.subarray(len.size, len.size + len.value);
    const id = decodeVarInt(body, 0);
    if (!id || id.value !== 0x00) return { kind: "error", message: "the reply isn't a Minecraft status" };
    const sl = decodeVarInt(body, id.size);
    if (!sl || sl.value < 0 || id.size + sl.size + sl.value > body.length) return { kind: "error", message: "the status reply is cut short" };
    const json = body.subarray(id.size + sl.size, id.size + sl.size + sl.value).toString("utf8");
    return { kind: "status", status: statusFromJson(json) };
  } catch (e) {
    return { kind: "error", message: e instanceof SyntaxError ? "the status reply isn't valid JSON" : e instanceof Error ? e.message : "the reply couldn't be read" };
  }
}
