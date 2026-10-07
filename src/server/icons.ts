import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./db";
import { safeFetch, type NetPolicy } from "./integrations/net";
import { listApps } from "./docker/apps";
import { pickEvictions, type CacheFile } from "./icons-cache";

/**
 * App icons, fetched once by the server and kept on disk. Icons come from app stores' CDNs
 * (GitHub, jsDelivr, selfh.st); through Gluon they keep loading when the internet is down, and
 * household members' browsers never contact those sites. A fetched icon is refreshed after a
 * week; if the refresh fails, the copy on disk is served.
 *
 * Bounded: household members only get icons of the apps on this server (not any URL they type), and the folder
 * keeps at most MAX_FILES icons and MAX_DIR_BYTES, dropping the least recently used. Admins may fetch any icon
 * (the app builder previews the address they enter), within the same caps.
 */

const DIR = path.join(DATA_DIR, "icons");
const FRESH_MS = 7 * 24 * 3_600_000;
const FAILED_MS = 30 * 60_000;
const MAX_BYTES = 6 * 1024 * 1024;
/** Raster icons bigger than this are scaled down to ICON_PX before they are kept. */
const KEEP_BYTES = 96 * 1024;
const ICON_PX = 256;
const MAX_FILES = 1500;
const MAX_DIR_BYTES = 48 * 1024 * 1024;

type G = typeof globalThis & {
  __gluonIconMisses?: Map<string, number>;
  __gluonIconInflight?: Map<string, Promise<Icon | null>>;
  __gluonIconIndex?: Promise<Map<string, CacheFile>>;
  __gluonIconAllowed?: { at: number; set: Promise<Set<string>> };
};
const g = globalThis as G;
const misses = (g.__gluonIconMisses ??= new Map());
const inflight = (g.__gluonIconInflight ??= new Map());

/** What's in the folder, read once per process and kept current as icons are written and evicted. */
function index(): Promise<Map<string, CacheFile>> {
  g.__gluonIconIndex ??= (async () => {
    const m = new Map<string, CacheFile>();
    const names = await fs.readdir(DIR).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        const dot = name.indexOf(".");
        if (dot < 1) return;
        const st = await fs.stat(path.join(DIR, name)).catch(() => null);
        if (st?.isFile()) m.set(name.slice(0, dot), { name, size: st.size, mtime: st.mtimeMs, used: st.mtimeMs });
      }),
    );
    return m;
  })();
  return g.__gluonIconIndex;
}

/** Icon addresses household members may ask for: the icons of the apps on this server. */
function memberAllowed(): Promise<Set<string>> {
  const now = Date.now();
  if (!g.__gluonIconAllowed || now - g.__gluonIconAllowed.at > 60_000) {
    const set = listApps()
      .then((apps) => new Set(apps.map((a) => a.icon).filter((x): x is string => !!x).map(normalise).filter((x): x is string => !!x)))
      .catch(() => new Set<string>());
    g.__gluonIconAllowed = { at: now, set };
  }
  return g.__gluonIconAllowed.set;
}

function normalise(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

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
  const idx = await index();
  const entry = idx.get(key);
  if (!entry) return null;
  const body = await fs.readFile(path.join(DIR, entry.name)).catch(() => null);
  if (!body) {
    idx.delete(key);
    return null;
  }
  entry.used = Date.now();
  const ext = entry.name.slice(key.length + 1);
  const type = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { type, body, at: entry.mtime };
}

async function store(key: string, icon: Icon) {
  const idx = await index();
  await fs.mkdir(DIR, { recursive: true });
  const name = `${key}.${EXT[icon.type]}`;
  const old = idx.get(key);
  if (old && old.name !== name) await fs.rm(path.join(DIR, old.name), { force: true });
  await fs.writeFile(path.join(DIR, name), icon.body);
  const t = Date.now();
  idx.set(key, { name, size: icon.body.length, mtime: t, used: t });
  for (const victim of pickEvictions(idx, { maxFiles: MAX_FILES, maxBytes: MAX_DIR_BYTES, keep: key })) {
    const e = idx.get(victim);
    idx.delete(victim);
    if (e) await fs.rm(path.join(DIR, e.name), { force: true }).catch(() => undefined);
  }
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
  // Members can't make the server fetch (and keep) whatever they like: only icons of the apps here.
  if (policy === "member" && !(await memberAllowed()).has(u.toString())) return null;
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
      await store(key, got).catch(() => undefined);
      return got;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const fresh = await job;
  return fresh ?? cached;
}
