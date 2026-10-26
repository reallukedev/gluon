/** Sites: types and path rules shared by the server and the editor. No server imports. */

import type { HttpsModeT, HttpsSettingsT } from "./network-types";

export const SITE_LIMITS = {
  /** Files in one site. */
  files: 2000,
  /** One file. */
  fileBytes: 25 * 1024 * 1024,
  /** Everything in the draft together. */
  siteBytes: 100 * 1024 * 1024,
  /** Largest file the editor opens as text. */
  textBytes: 2 * 1024 * 1024,
  /** Largest .zip that can be imported. */
  zipBytes: 100 * 1024 * 1024,
  /** Folders inside folders. */
  depth: 12,
  pathLength: 400,
  nameLength: 120,
  /** Published versions kept for rolling back, the live one included. */
  versions: 5,
} as const;

export type SiteFileKind = "text" | "image" | "other";

/** How the editor treats a file, from its extension. */
export type SiteLanguage = "html" | "css" | "javascript" | "json" | "markdown" | "xml" | "text";

const TEXT: Record<string, SiteLanguage> = {
  html: "html",
  htm: "html",
  css: "css",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  webmanifest: "json",
  map: "json",
  md: "markdown",
  markdown: "markdown",
  svg: "xml",
  xml: "xml",
  txt: "text",
  csv: "text",
};
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg"]);

export const extOf = (p: string) => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export function kindOf(p: string): SiteFileKind {
  const e = extOf(p);
  if (e in TEXT) return "text";
  if (IMAGE.has(e)) return "image";
  return "other";
}

export const languageOf = (p: string): SiteLanguage => TEXT[extOf(p)] ?? "text";
export const isImage = (p: string) => IMAGE.has(extOf(p));

// Letters and numbers in any script, plus the punctuation that's safe in a web address without escaping surprises.
const NAME_CHARS = /^[\p{L}\p{N}\p{M} _.,()+@~!&'=-]+$/u;

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

/**
 * A path inside a site: "about/index.html". No "..", nothing absolute, no hidden files except a
 * .well-known folder at the top, and only characters that behave in a web address.
 */
export function checkSitePath(raw: string): PathCheck {
  const p = String(raw ?? "").normalize("NFC").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return { ok: false, message: "Give it a name." };
  if (p.includes("\\")) return { ok: false, message: "Use / between folders, not \\." };
  if (p.length > SITE_LIMITS.pathLength) return { ok: false, message: `That path is too long. Keep it under ${SITE_LIMITS.pathLength} characters.` };
  const parts = p.split("/");
  if (parts.length > SITE_LIMITS.depth) return { ok: false, message: `Folders can only go ${SITE_LIMITS.depth} deep.` };
  for (const [i, seg] of parts.entries()) {
    if (!seg) return { ok: false, message: "A path can't have two slashes in a row." };
    if (seg === "." || seg === "..") return { ok: false, message: "A path can't step out of its folder with “..” or “.”." };
    if (seg.startsWith(".") && !(i === 0 && seg === ".well-known")) {
      return { ok: false, message: `“${seg}” starts with a dot, which makes it a hidden file that the site won't serve. Only a .well-known folder at the top is allowed.` };
    }
    if (seg.length > SITE_LIMITS.nameLength) return { ok: false, message: `“${seg.slice(0, 24)}…” is too long. Keep names under ${SITE_LIMITS.nameLength} characters.` };
    if (seg !== seg.trim()) return { ok: false, message: `“${seg}” starts or ends with a space. Take the space out.` };
    if (seg.endsWith(".")) return { ok: false, message: `“${seg}” ends with a dot. Take it out or add an extension.` };
    if (!NAME_CHARS.test(seg)) return { ok: false, message: `“${seg}” has a character that doesn't work in a web address. Use letters, numbers, spaces and . _ - ( ) + , @ ~ ! & ' =` };
  }
  return { ok: true, path: parts.join("/") };
}

/** Hidden files a computer adds by itself; uploads skip them without asking. */
export const isJunk = (p: string) => p.split("/").some((s) => s === "__MACOSX" || s === ".DS_Store" || s === "Thumbs.db" || s === "desktop.ini" || s.startsWith("._"));

export interface SiteFile {
  path: string;
  size: number;
  mtime: number;
  kind: SiteFileKind;
}

export interface SiteTree {
  files: SiteFile[];
  /** Every folder, empty ones included. */
  dirs: string[];
  bytes: number;
  /** Changes with every edit, so the editor can tell when another tab changed something. */
  rev: number;
}

export type SiteState = "live" | "off" | "draft" | "broken";

export interface SiteAddress {
  host: string;
  url: string;
  https: HttpsModeT;
  httpsSetting?: HttpsSettingsT;
  /** The wildcard DNS record already covers it. */
  wildcard: boolean;
}

export interface SiteSummary {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string | null;
  draft: { files: number; bytes: number; changedAt: number; changedBy: string | null; rev: number };
  /** The address it has or had (kept while it's off). */
  address: SiteAddress | null;
  /**
   * live: the address is on and serves a version. off: the address is kept but turned off.
   * draft: never published. broken: the address points at a version Gluon no longer has.
   */
  state: SiteState;
  live: { version: string; at: number | null; by: string | null } | null;
  /** The draft has edits the live version doesn't. */
  changes: boolean;
}

export interface SiteVersion {
  version: string;
  createdAt: number;
  createdBy: string | null;
  files: number;
  bytes: number;
  live: boolean;
}

export interface SiteDetail extends SiteSummary {
  versions: SiteVersion[];
  baseDomain: string | null;
  /** Names other addresses already use, so the publish form can say whether one is free. */
  taken: { host: string; name: string }[];
  /** The routes file can't be read, so nothing can be published yet. */
  addressesUnavailable: string | null;
}

export interface SitesList {
  sites: SiteSummary[];
  baseDomain: string | null;
}

export interface SiteTextFile {
  path: string;
  kind: "text";
  text: string;
  /** Changes whenever the file's content does. Saving sends it back to catch edits made elsewhere. */
  etag: string;
  size: number;
}

export interface SiteBinaryFile {
  path: string;
  kind: "binary";
  size: number;
  etag: string;
  /** Why it doesn't open as text. */
  reason: "binary" | "too-large";
}

export type SiteFileContent = SiteTextFile | SiteBinaryFile;

export interface SitePreview {
  /** Opens the site's start page in the preview; other pages are relative to it. */
  url: string;
  /** The part before the page path, to open another page in the preview. */
  base: string;
  expiresAt: number;
}

export interface SiteImportResult {
  added: number;
  replaced: number;
  skipped: { path: string; reason: string }[];
  tree: SiteTree;
}
