/**
 * Just enough tar for Docker's archive API (GET/PUT /containers/{id}/archive): read the entries
 * of an archive, and write regular files with a chosen owner and mode.
 */

export interface TarEntry {
  name: string;
  type: "file" | "dir" | "other";
  mode: number;
  uid: number;
  gid: number;
  data: Buffer;
}

const BLOCK = 512;

function str(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = str(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** PAX extended header records: "<len> key=value\n". */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.toString("utf8", i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const flag = String.fromCharCode(h[156]!);
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "g") continue;
    if (flag === "L") {
      longName = str(data, 0, data.length);
      continue;
    }
    const prefix = str(h, 345, 155);
    const base = str(h, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    out.push({
      name: name.replace(/^\.\//, "").replace(/\/$/, ""),
      type: flag === "0" || flag === "\0" ? "file" : flag === "5" ? "dir" : "other",
      mode: octal(h, 100, 8) & 0o7777,
      uid: pax.uid ? Number(pax.uid) : octal(h, 108, 8),
      gid: pax.gid ? Number(pax.gid) : octal(h, 116, 8),
      data: Buffer.from(data),
    });
    pax = {};
    longName = null;
  }
  return out;
}

/** A PAX record "<len> key=value\n", where len counts the whole record including its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function header(name: string, size: number, mode: number, uid: number, gid: number, mtime: number, flag = "0"): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const put = (s: string, start: number, len: number) => h.write(s, start, len, "utf8");
  const num = (n: number, start: number, len: number) => put(n.toString(8).padStart(len - 1, "0") + "\0", start, len);
  put(name, 0, 100);
  num(mode, 100, 8);
  num(uid, 108, 8);
  num(gid, 116, 8);
  num(size, 124, 12);
  num(mtime, 136, 12);
  put("        ", 148, 8);
  put(flag, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function writeTar(files: { name: string; data: Buffer; mode: number; uid: number; gid: number }[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;
  for (const f of files) {
    let name = f.name;
    // Names past ustar's 100 bytes (a long chat domain's "<host>.key") go in a PAX header.
    if (Buffer.byteLength(name) > 100) {
      const pax = Buffer.from(paxRecord("path", name));
      parts.push(header("PaxHeader", pax.length, 0o644, 0, 0, mtime, "x"), pax, Buffer.alloc(pad(pax.length), 0));
      name = Buffer.from(name).subarray(0, 100).toString("utf8").replace(/\uFFFD$/, "");
    }
    parts.push(header(name, f.data.length, f.mode, f.uid, f.gid, mtime), f.data, Buffer.alloc(pad(f.data.length), 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
