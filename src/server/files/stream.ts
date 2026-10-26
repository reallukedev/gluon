import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { AppError } from "../errors";
import { isWithin } from "../host/paths";
import type { User } from "../auth/users";
import { authorize } from "./paths";
import { kindOf, mimeOf } from "./kinds";

/** Special trees where files are pseudo-files (sizes lie, reads can block or never end). */
const NO_STREAM = ["/proc", "/sys", "/dev", "/run"];

/** RFC 6266 / 5987 Content-Disposition with a safe ASCII fallback. */
export function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function etagOf(st: fs.Stats) {
  return `"${st.ino.toString(36)}-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
}

/**
 * Types a browser would render as a page: serve them as plain text when inline. (SVG stays an
 * image so <img> previews work; the sandbox CSP below stops its scripts if opened directly.)
 */
const ACTIVE = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)/;

interface Range {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): Range | "unsatisfiable" | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // multi-range or junk: send the whole file (allowed by RFC 9110)
  const [, a, b] = m;
  if (!a && !b) return null;
  let start: number;
  let end: number;
  if (!a) {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Stream a file with Range support. Inline for previewable types, attachment when `download` or
 * when the type isn't safe to render. Every response gets a sandboxing CSP so an uploaded HTML/SVG
 * file can never run script on Gluon's origin.
 */
export async function streamFile(req: NextRequest, user: User, rawPath: string, download: boolean): Promise<Response> {
  const t = await authorize(user, rawPath, "read");
  if (NO_STREAM.some((p) => isWithin(t.real, p))) {
    throw new AppError("not_streamable", "Files in system folders like /proc and /dev can't be downloaded.", 400);
  }
  if (t.stat?.isDirectory()) throw new AppError("is_folder", "That's a folder. Download it as a zip instead.", 400, { type: "dir" });
  if (!t.stat?.isFile()) throw new AppError("not_a_file", "That isn't a regular file, so it can't be downloaded.", 400);

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(t.fsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new AppError("forbidden", "The server isn't allowed to read that file.", 403);
    if (code === "ELOOP") throw new AppError("changed", "That file changed while opening it. Try again.", 409);
    throw e;
  }
  let handed = false;
  try {
    const st = await fh.stat();
    // The path could have been swapped between resolving and opening: make sure it's still the same file.
    if (!st.isFile() || st.ino !== t.stat.ino || st.dev !== t.stat.dev) {
      throw new AppError("changed", "That file changed while opening it. Try again.", 409);
    }
    const name = path.posix.basename(t.path);
    const size = st.size;
    const etag = etagOf(st);
    const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();

    let type = mimeOf(name) ?? "application/octet-stream";
    const kind = kindOf(name);
    let inline = !download;
    if (inline && ACTIVE.test(type)) type = "text/plain";
    if (type.startsWith("text/") && !type.includes("charset")) type += "; charset=utf-8";
    if (inline && type === "application/octet-stream" && kind !== "text") inline = false;

    const headers: Record<string, string> = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": lastModified,
      "Cache-Control": "private, no-cache",
      "Content-Disposition": disposition(inline ? "inline" : "attachment", name),
      "X-Content-Type-Options": "nosniff",
      // PDFs need the browser's viewer (blocked by `sandbox`); everything else is sandboxed.
      "Content-Security-Policy": type === "application/pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      "X-Frame-Options": "SAMEORIGIN",
    };

    // Conditional requests.
    const inm = req.headers.get("if-none-match");
    const ims = req.headers.get("if-modified-since");
    if ((inm && inm.split(/\s*,\s*/).some((v) => v === etag || v === `W/${etag}` || v === "*")) || (!inm && ims && Date.parse(ims) >= Date.parse(lastModified))) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Last-Modified": lastModified, "Cache-Control": headers["Cache-Control"]! } });
    }

    let range = parseRange(req.headers.get("range"), size);
    const ifRange = req.headers.get("if-range");
    if (range && ifRange && ifRange !== etag && Date.parse(ifRange) !== Date.parse(lastModified)) range = null;
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = String(length);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

    if (req.method === "HEAD" || length === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }

    const nodeStream = fh.createReadStream({ start, end, highWaterMark: 256 * 1024, autoClose: true });
    handed = true;
    const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    req.signal.addEventListener("abort", () => nodeStream.destroy());
    return new Response(web, { status: range ? 206 : 200, headers });
  } finally {
    if (!handed) await fh.close().catch(() => {});
  }
}
