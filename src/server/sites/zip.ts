import "server-only";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Open, type File as ZipFile } from "unzipper";
import { AppError } from "../errors";
import { formatBytes } from "@/lib/format";
import { checkSitePath, isJunk, SITE_LIMITS } from "@/lib/sites-types";

/**
 * Reading a .zip into a site, safely. Nothing is written until every entry has been checked:
 * an entry that tries to climb out of the site ("../x", "/etc/x", "C:\x") refuses the whole zip,
 * links and hidden files are skipped and listed, and sizes are counted as bytes come out, never
 * trusted from the zip's own directory (a zip bomb can claim anything).
 */

export interface ZipPlan {
  /** Checked paths with the zip entry each comes from. */
  entries: { rel: string; file: ZipFile }[];
  skipped: { path: string; reason: string }[];
  /** Declared total, for the size check before anything is extracted. */
  bytes: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A link in a zip made on a Mac or Linux (the type lives in the high bits of the external attributes). */
const isLink = (f: ZipFile) => ((f.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

function escapes(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  return n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..");
}

/** Read the zip's directory and decide what goes where. Throws when the zip itself isn't safe. */
export async function planZip(buf: Buffer): Promise<ZipPlan> {
  let dir: Awaited<ReturnType<typeof Open.buffer>>;
  try {
    dir = await Open.buffer(buf);
  } catch {
    throw new AppError("bad_zip", "That file isn't a .zip Gluon can read. Make the zip again and try once more.", 400);
  }
  const files = dir.files;
  const bad = files.find((f) => escapes(f.path));
  if (bad) throw new AppError("zip_slip", `This zip has files that point outside its own folder (like “${bad.path.slice(0, 80)}”), so Gluon didn't import any of it.`, 400);
  if (files.some((f) => (f.flags & 1) === 1)) {
    throw new AppError("zip_encrypted", "This zip is password protected. Make it again without a password.", 400);
  }

  const skipped: ZipPlan["skipped"] = [];
  const real = files.filter((f) => f.type === "File" && !isJunk(f.path.replace(/\\/g, "/")));
  // Most zips of a website hold one folder ("my-site/index.html"); its contents are the site.
  const names = real.map((f) => f.path.replace(/\\/g, "/"));
  const tops = new Set(names.map((n) => (n.includes("/") ? n.split("/")[0] : "")));
  const strip = tops.size === 1 && !tops.has("") && !names.includes("index.html") ? `${[...tops][0]}/` : "";
  const entries: ZipPlan["entries"] = [];
  let bytes = 0;
  for (const f of real) {
    const name = f.path.replace(/\\/g, "/").slice(strip.length);
    if (isLink(f)) {
      skipped.push({ path: name, reason: "It's a link, and sites can only hold real files." });
      continue;
    }
    const c = checkSitePath(name);
    if (!c.ok) {
      skipped.push({ path: name, reason: c.message });
      continue;
    }
    if (f.uncompressedSize > SITE_LIMITS.fileBytes) throw new AppError("too_large", `“${c.path}” in the zip is ${formatBytes(f.uncompressedSize)}. Files can be up to ${formatBytes(SITE_LIMITS.fileBytes)}.`, 413);
    bytes += f.uncompressedSize;
    entries.push({ rel: c.path, file: f });
  }
  if (entries.length > SITE_LIMITS.files) throw new AppError("too_many_files", `This zip has ${entries.length} files, and a site can have up to ${SITE_LIMITS.files}.`, 413);
  if (bytes > SITE_LIMITS.siteBytes) throw new AppError("site_too_large", `This zip unpacks to ${formatBytes(bytes)}, and a site can hold up to ${formatBytes(SITE_LIMITS.siteBytes)}.`, 413);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.rel)) throw new AppError("bad_zip", `The zip has “${e.rel}” twice. Make it again and try once more.`, 400);
    seen.add(e.rel);
  }
  return { entries, skipped, bytes };
}

/** Extract one entry to `tmp`, stopping when it gives more than it declared (or more than a file may be). */
export async function extractEntry(file: ZipFile, tmp: string): Promise<number> {
  const cap = Math.min(file.uncompressedSize, SITE_LIMITS.fileBytes);
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > cap) cb(new AppError("bad_zip", `“${file.path.slice(0, 80)}” unpacks to more than the zip says it holds, so Gluon stopped. The zip may be damaged.`, 400));
      else cb(null, chunk);
    },
  });
  await pipeline(file.stream(), counter, fs.createWriteStream(tmp, { flags: "wx", mode: 0o644 }));
  return n;
}
