import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { AppError } from "../errors";
import { DATA_DIR } from "../db";
import type { User } from "../auth/users";
import { authorize } from "./paths";
import { kindOf } from "./kinds";
import { etagOf } from "./stream";

/**
 * Small WebP thumbnails for the grid view, made with sharp (which ships with Next.js) and kept in
 * /data/thumbs keyed by the file's identity, so a photo is decoded once, not every time a folder
 * scrolls past it. If sharp can't load, or the format isn't one it reads, the client falls back to
 * the file's glyph.
 */

const DIR = path.join(DATA_DIR, "thumbs");
const SIZES = [160, 320, 480] as const;
const MAX_INPUT = 200 * 1024 * 1024;
const MAX_CACHE = 400 * 1024 * 1024;
const READABLE = /\.(jpe?g|png|webp|gif|avif|tiff?|bmp|heic|heif|svg)$/i;

type Sharp = typeof import("sharp").default;
type G = typeof globalThis & { __gluonSharp?: Promise<Sharp | null>; __gluonThumbActive?: number; __gluonThumbQueue?: (() => void)[]; __gluonThumbSwept?: number };
const g = globalThis as G;

function sharp(): Promise<Sharp | null> {
  g.__gluonSharp ??= import("sharp")
    .then((m) => {
      const s = ((m as { default?: Sharp }).default ?? m) as Sharp;
      s.cache(false);
      s.concurrency(1);
      return s;
    })
    .catch(() => null);
  return g.__gluonSharp;
}

/** At most two decodes at a time: a folder of 4000 photos must not starve the server. */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  g.__gluonThumbQueue ??= [];
  if ((g.__gluonThumbActive ?? 0) >= 2) await new Promise<void>((r) => g.__gluonThumbQueue!.push(r));
  g.__gluonThumbActive = (g.__gluonThumbActive ?? 0) + 1;
  try {
    return await fn();
  } finally {
    g.__gluonThumbActive = Math.max(0, (g.__gluonThumbActive ?? 1) - 1);
    g.__gluonThumbQueue.shift()?.();
  }
}

/** Keep the cache under MAX_CACHE, oldest first. Runs at most every 10 minutes. */
function sweep() {
  if (Date.now() - (g.__gluonThumbSwept ?? 0) < 10 * 60_000) return;
  g.__gluonThumbSwept = Date.now();
  setTimeout(() => {
    try {
      const files = fs.readdirSync(DIR).map((n) => {
        const st = fs.statSync(path.join(DIR, n));
        return { n, size: st.size, at: st.atimeMs };
      });
      let total = files.reduce((a, f) => a + f.size, 0);
      if (total <= MAX_CACHE) return;
      for (const f of files.sort((a, b) => a.at - b.at)) {
        fs.rmSync(path.join(DIR, f.n), { force: true });
        total -= f.size;
        if (total <= MAX_CACHE * 0.8) break;
      }
    } catch {
      /* best effort */
    }
  }, 2000).unref?.();
}

export async function thumbnail(req: NextRequest, user: User, rawPath: string, want: number): Promise<Response> {
  const t = await authorize(user, rawPath, "read");
  if (!t.stat?.isFile()) throw new AppError("not_a_file", "Only files have thumbnails.", 400);
  const name = path.posix.basename(t.path);
  if (kindOf(name) !== "image" || !READABLE.test(name)) throw new AppError("no_thumbnail", "This kind of file has no thumbnail.", 415);
  if (t.stat.size > MAX_INPUT) throw new AppError("too_big", "This image is too big to make a thumbnail of.", 415);
  const size = SIZES.find((s) => s >= want) ?? SIZES[SIZES.length - 1];
  const etag = `"t${size}-${etagOf(t.stat).slice(1)}`;
  const headers = { "Content-Type": "image/webp", ETag: etag, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const key = crypto.createHash("sha1").update(`${t.real}\0${t.stat.dev}:${t.stat.ino}:${t.stat.size}:${Math.floor(t.stat.mtimeMs)}:${size}`).digest("hex");
  const file = path.join(DIR, `${key}.webp`);
  try {
    const buf = await fs.promises.readFile(file);
    return new Response(new Uint8Array(buf), { headers });
  } catch {
    /* not cached yet */
  }

  const lib = await sharp();
  if (!lib) throw new AppError("no_thumbnail", "Thumbnails aren't available on this server.", 415);
  let out: Buffer;
  try {
    out = await slot(() =>
      lib(t.fsPath, { failOn: "none", limitInputPixels: 120_000_000, animated: false, density: 72 })
        .rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true })
        .webp({ quality: 72, effort: 2 })
        .toBuffer(),
    );
  } catch {
    throw new AppError("no_thumbnail", "This image couldn't be read.", 415);
  }
  try {
    await fs.promises.mkdir(DIR, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, out);
    sweep();
  } catch {
    /* cache is optional */
  }
  return new Response(new Uint8Array(out), { headers });
}
