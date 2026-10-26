import "server-only";
import fs from "node:fs";
import mime from "mime";
import { hmac, safeEqual } from "../crypto";
import { SITE_ID_RE, SITE_VERSION_RE } from "../caddy/routes";
import { checkSitePath } from "@/lib/sites-types";
import { draftDir, resolveIn } from "./store";
import { versionDir } from "./versions";

/**
 * Previews of a draft (or an older version) run the site's own HTML and scripts, which Gluon
 * didn't write. They're served from Gluon's address but never as Gluon: every response carries
 * `Content-Security-Policy: sandbox`, so the browser gives the page an opaque origin with no
 * cookies, no storage and no way to read or call Gluon, and the frame showing it has the same
 * sandbox. Cookies don't reach an opaque origin, so the URL itself carries a short-lived signed
 * token; relative links and assets keep working because the token is a path segment.
 */

export const PREVIEW_PREFIX = "/api/sites/preview";
export const PREVIEW_TTL_MS = 60 * 60_000;
const PURPOSE = "sites.preview";

/** Allowed in the frame: scripts and forms and popups (which inherit the sandbox). Never same-origin, never top navigation. */
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups";

export const PREVIEW_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `sandbox ${PREVIEW_SANDBOX}; frame-ancestors 'self'`,
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export type PreviewTarget = "draft" | string;

export interface PreviewToken {
  site: string;
  target: PreviewTarget;
  expires: number;
}

const TOKEN_RE = /^([a-z0-9]{6,32})\.(draft|\d{8}T\d{6}Z(?:-\d{1,3})?)\.([0-9a-z]{1,11})\.([0-9a-f]{32})$/;

export function signPreview(site: string, target: PreviewTarget, nowMs = Date.now()): { token: string; expires: number } {
  if (!SITE_ID_RE.test(site) || !(target === "draft" || SITE_VERSION_RE.test(target))) throw new Error("bad preview target");
  const expires = nowMs + PREVIEW_TTL_MS;
  const payload = `${site}.${target}.${Math.floor(expires / 1000).toString(36)}`;
  return { token: `${payload}.${hmac(PURPOSE, payload).slice(0, 32)}`, expires: Math.floor(expires / 1000) * 1000 };
}

/** The token's site and target, or null when it's malformed, forged or expired. */
export function verifyPreview(token: string, nowMs = Date.now()): PreviewToken | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const payload = `${m[1]}.${m[2]}.${m[3]}`;
  if (!safeEqual(hmac(PURPOSE, payload).slice(0, 32), m[4]!)) return null;
  const expires = parseInt(m[3]!, 36) * 1000;
  if (!(expires > nowMs)) return null;
  return { site: m[1]!, target: m[2]!, expires };
}

const page = (status: number, title: string, text: string) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem"><h1 style="font-size:1.15rem;font-weight:600">${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/html; charset=utf-8" } },
  );

const TEXTY = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/;

function typeOf(p: string): string {
  const t = mime.getType(p) ?? "application/octet-stream";
  return TEXTY.test(t) ? `${t}; charset=utf-8` : t;
}

/**
 * Links that start with "/" mean the site's own root once it's published; in the preview that root
 * is the token's folder. Rewrites them in HTML attributes and CSS url()/@import. Only the preview
 * changes, never the files.
 */
export function rewriteRootLinks(text: string, kind: "html" | "css", base: string): string {
  const fix = (u: string) => (u.startsWith("/") && !u.startsWith("//") ? `${base}${u}` : u);
  const css = (s: string) =>
    s
      .replace(/url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/g, (_m, q: string, u: string) => `url(${q}${fix(u)}${q})`)
      .replace(/@import\s+(['"])(\/(?!\/)[^'"]*)\1/g, (_m, q: string, u: string) => `@import ${q}${fix(u)}${q}`);
  if (kind === "css") return css(text);
  return css(
    text
      .replace(/(\s(?:href|src|action|formaction|poster|data|background)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi, (_m, a: string, q: string, u: string) => `${a}${q}${fix(u)}${q}`)
      .replace(/(\s(?:srcset|imagesrcset)\s*=\s*)(["'])([^"']*)\2/gi, (_m, a: string, q: string, list: string) => `${a}${q}${list.replace(/(^|,\s*)(\/(?!\/)[^\s,]+)/g, (_x, sep: string, u: string) => `${sep}${fix(u)}`)}${q}`),
  );
}

function rootFor(t: PreviewToken): string | null {
  if (t.target === "draft") return draftDir(t.site);
  const dir = versionDir(t.site, t.target);
  return fs.existsSync(dir) ? dir : null;
}

function serveFile(abs: string, rel: string, base: string, status: number, head: boolean): Response {
  const type = typeOf(rel);
  const headers = { ...PREVIEW_HEADERS, "Content-Type": type };
  const isHtml = type.startsWith("text/html");
  const isCss = type.startsWith("text/css");
  if (isHtml || isCss) {
    const text = rewriteRootLinks(fs.readFileSync(abs, "utf8"), isHtml ? "html" : "css", base);
    return new Response(head ? null : text, { status, headers });
  }
  const st = fs.statSync(abs);
  if (head) return new Response(null, { status, headers: { ...headers, "Content-Length": String(st.size) } });
  return new Response(new Uint8Array(fs.readFileSync(abs)), { status, headers: { ...headers, "Content-Length": String(st.size) } });
}

/**
 * Serve one preview request the way Caddy serves the published site: the file, else the same
 * name with .html, else a folder's index.html, else the site's own 404.html with a 404.
 */
export function servePreview(token: string, segments: string[], head: boolean): Response {
  const t = verifyPreview(token);
  if (!t) return page(410, "This preview has expired", "Preview links stop working after an hour. Open the site in Gluon again to get a fresh one.");
  const root = rootFor(t);
  if (!root || !fs.existsSync(root)) return page(404, "Nothing to preview", "This site or version doesn't exist any more.");
  const base = `${PREVIEW_PREFIX}/${token}`;
  const raw = segments.join("/");
  const try1 = (rel: string) => {
    if (!checkSitePath(rel).ok) return null;
    try {
      const { abs, st } = resolveIn(root, rel);
      return st ? { abs, st, rel } : null;
    } catch {
      return null;
    }
  };
  if (raw) {
    const hit = try1(raw);
    if (hit?.st.isFile()) return serveFile(hit.abs, hit.rel, base, 200, head);
    const html = try1(`${raw}.html`);
    if (html?.st.isFile()) return serveFile(html.abs, html.rel, base, 200, head);
    // Folders open their index.html at its full name, so the page's relative links resolve inside the folder.
    if (hit?.st.isDirectory() && try1(`${raw}/index.html`)?.st.isFile()) return redirect(`${base}/${encodePath(raw)}/index.html`);
  } else if (try1("index.html")?.st.isFile()) return redirect(`${base}/index.html`);
  const nf = try1("404.html");
  if (nf?.st.isFile()) return serveFile(nf.abs, nf.rel, base, 404, head);
  return page(404, "Not found", raw ? `The site has no file called “${raw.replace(/[<>&"]/g, "")}”.` : "The site has no index.html yet, which is the page people see first.");
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function redirect(to: string) {
  return new Response(null, { status: 307, headers: { ...PREVIEW_HEADERS, Location: to } });
}

export const previewBase = (token: string) => `${PREVIEW_PREFIX}/${token}`;
