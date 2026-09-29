import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./db";
import { safeFetch, type NetPolicy } from "./integrations/net";

/**
 * App icons, fetched once by the server and kept on disk. Icons come from app stores' CDNs
 * (GitHub, jsDelivr, selfh.st); through Gluon they keep loading when the internet is down, and
 * household members' browsers never contact those sites. A fetched icon is refreshed after a
 * week; if the refresh fails, the copy on disk is served.
 */

const DIR = path.join(DATA_DIR, "icons");
const FRESH_MS = 7 * 24 * 3_600_000;
const FAILED_MS = 30 * 60_000;
const MAX_BYTES = 6 * 1024 * 1024;
/** Raster icons bigger than this are scaled down to ICON_PX before they are kept. */
const KEEP_BYTES = 96 * 1024;
const ICON_PX = 256;

type G = typeof globalThis & { __gluonIconMisses?: Map<string, number>; __gluonIconInflight?: Map<string, Promise<Icon | null>> };
const g = globalThis as G;
const misses = (g.__gluonIconMisses ??= new Map());
const inflight = (g.__gluonIconInflight ??= new Map());

export interface Icon {
  type: string;
  body: Buffer;
}

const EXT: Record<string, string> = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif" };

function sniff(type: string, body: Buffer): string | null {
  const t = type.split(";")[0]!.trim().toLowerCase();
  if (EXT[t]) return t;
  const head = body.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  if (body[0] === 0x89 && body[1] === 0x50) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function readCached(key: string): Promise<(Icon & { at: number }) | null> {
  const files = await fs.readdir(DIR).catch(() => [] as string[]);
  const name = files.find((f) => f.startsWith(`${key}.`));
  if (!name) return null;
  const file = path.join(DIR, name);
  const [body, st] = await Promise.all([fs.readFile(file), fs.stat(file)]);
  const ext = name.slice(key.length + 1);
  const type = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { type, body, at: st.mtimeMs };
}

async function fetchIcon(url: string, policy: NetPolicy): Promise<Icon | null> {
  try {
    const r = await safeFetch(url, { policy, maxBytes: MAX_BYTES, timeoutMs: 5000, totalMs: 8000, maxRedirects: 3, headers: { Accept: "image/*" } });
    if (r.status < 200 || r.status >= 300) return null;
    const type = sniff(String(r.headers["content-type"] ?? ""), r.body);
    if (!type) return null;
    if (type === "image/svg+xml") return r.body.length <= 512 * 1024 ? { type, body: r.body } : null;
    if (r.body.length <= KEEP_BYTES) return { type, body: r.body };
    // A 1.4 MB logo is common in repos; icons draw at 24–64 px, so keep a small PNG instead.
    const sharp = (await import("sharp")).default;
    const body = await sharp(r.body, { limitInputPixels: 64_000_000 }).resize(ICON_PX, ICON_PX, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    return { type: "image/png", body };
  } catch {
    return null;
  }
}

export async function appIcon(raw: string, policy: NetPolicy): Promise<Icon | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const key = crypto.createHash("sha256").update(`${policy}\0${u.toString()}`).digest("hex").slice(0, 40);
  const cached = await readCached(key).catch(() => null);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached;
  const missed = misses.get(key);
  if (!cached && missed && Date.now() - missed < FAILED_MS) return null;

  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const got = await fetchIcon(u.toString(), policy);
      if (!got) {
        misses.set(key, Date.now());
        return null;
      }
      await fs.mkdir(DIR, { recursive: true });
      const old = (await fs.readdir(DIR).catch(() => [] as string[])).filter((f) => f.startsWith(`${key}.`));
      await Promise.all(old.map((f) => fs.rm(path.join(DIR, f), { force: true })));
      await fs.writeFile(path.join(DIR, `${key}.${EXT[got.type]}`), got.body);
      return got;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const fresh = await job;
  return fresh ?? cached;
}
