import "server-only";
import mime from "mime";
import type { FileKind, PreviewKind } from "@/lib/files-types";

const EXT: Record<Exclude<FileKind, "folder" | "other">, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "svg", "ico", "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "psd", "xcf", "jxl"],
  video: ["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "m2ts", "mts", "ts", "3gp", "ogv", "vob", "divx", "rmvb"],
  audio: ["mp3", "m4a", "m4b", "aac", "flac", "wav", "ogg", "oga", "opus", "wma", "alac", "aiff", "aif", "ape", "wv", "dsf", "dff", "mka", "mid", "midi"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "epub", "mobi", "azw3", "cbz", "cbr", "djvu", "pages", "numbers", "key"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz", "zst", "tzst", "7z", "rar", "lz", "lzma", "lz4", "cab", "deb", "rpm", "apk", "jar"],
  "disk-image": ["iso", "img", "qcow2", "qcow", "vmdk", "vdi", "vhd", "vhdx", "dmg", "raw", "wim", "esd"],
  text: [
    "txt", "md", "markdown", "rst", "log", "nfo", "srt", "vtt", "ass", "ssa", "sub", "cue", "m3u", "m3u8", "pls",
    "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "conf", "cfg", "cnf", "env", "properties", "xml", "plist", "csv", "tsv",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "py", "rb", "pl", "php", "lua", "js", "mjs", "cjs", "ts", "tsx", "jsx", "go", "rs",
    "c", "h", "cc", "cpp", "hpp", "java", "kt", "swift", "cs", "sql", "css", "scss", "less", "html", "htm", "vue", "svelte",
    "dockerfile", "service", "timer", "socket", "mount", "rules", "caddyfile", "gitignore", "gitattributes", "editorconfig", "lock", "diff", "patch",
  ],
};

const BY_EXT = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(EXT) as [FileKind, string[]][]) {
  for (const e of exts) if (!BY_EXT.has(e)) BY_EXT.set(e, kind);
}

/** Names without an extension that are plainly text. */
const TEXT_NAMES = new Set(["dockerfile", "makefile", "readme", "license", "caddyfile", "fstab", "hosts", "hostname", "crontab", "authorized_keys", "known_hosts", "config", ".env", ".bashrc", ".profile", ".zshrc", ".gitignore", "vagrantfile", "procfile", "changelog"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function kindOf(name: string, isDir = false): FileKind {
  if (isDir) return "folder";
  const lower = name.toLowerCase();
  if (/\.tar\.(gz|bz2|xz|zst|lz4|lz)$/.test(lower)) return "archive";
  const k = BY_EXT.get(extOf(lower));
  if (k) return k;
  if (TEXT_NAMES.has(lower) || lower.startsWith("docker-compose") || lower.startsWith(".env")) return "text";
  const m = mime.getType(lower);
  if (m?.startsWith("image/")) return "image";
  if (m?.startsWith("video/")) return "video";
  if (m?.startsWith("audio/")) return "audio";
  if (m?.startsWith("text/")) return "text";
  return "other";
}

export function mimeOf(name: string): string | null {
  const lower = name.toLowerCase();
  const e = extOf(lower);
  // Common home-server formats mime-db is vague about.
  const extra: Record<string, string> = { mkv: "video/x-matroska", mka: "audio/x-matroska", m4b: "audio/mp4", flac: "audio/flac", opus: "audio/ogg", ts: "video/mp2t", srt: "text/plain", vtt: "text/vtt", nfo: "text/plain", log: "text/plain", conf: "text/plain", env: "text/plain", yml: "text/yaml", yaml: "text/yaml", md: "text/markdown", tsx: "text/plain", zst: "application/zstd", heic: "image/heic" };
  if (extra[e]) return extra[e]!;
  return mime.getType(lower) ?? (kindOf(name) === "text" ? "text/plain" : null);
}

/** What the browser can show inline. */
const IMG_PREVIEW = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico"]);
const VIDEO_PREVIEW = new Set(["mp4", "m4v", "webm", "mov", "mkv", "ogv"]);
const AUDIO_PREVIEW = new Set(["mp3", "m4a", "m4b", "aac", "flac", "wav", "ogg", "oga", "opus", "weba"]);

export function previewOf(name: string, kind: FileKind): PreviewKind {
  const e = extOf(name);
  if (kind === "image") return IMG_PREVIEW.has(e) ? "image" : null;
  if (kind === "video") return VIDEO_PREVIEW.has(e) ? "video" : null;
  if (kind === "audio") return AUDIO_PREVIEW.has(e) ? "audio" : null;
  if (e === "pdf") return "pdf";
  if (kind === "text" || e === "csv" || e === "tsv") return "text";
  return null;
}

/** Already-compressed formats: zip them with STORE so downloads don't burn CPU for nothing. */
const COMPRESSED = new Set([
  ...EXT.video, ...EXT.archive, "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "jxl",
  "mp3", "m4a", "m4b", "aac", "flac", "ogg", "oga", "opus", "wma", "ape", "wv", "mka",
  "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "cbz", "cbr", "pdf", "dmg", "qcow2", "vmdk",
]);
export function isCompressed(name: string) {
  return COMPRESSED.has(extOf(name));
}

/** Syntax hint for the text editor. */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "caddyfile") return "caddyfile";
  if (lower.startsWith(".env") || lower.endsWith(".env")) return "ini";
  const e = extOf(lower);
  const map: Record<string, string> = { yml: "yaml", yaml: "yaml", json: "json", jsonc: "json", json5: "json", toml: "toml", ini: "ini", conf: "ini", cfg: "ini", cnf: "ini", properties: "ini", service: "ini", timer: "ini", socket: "ini", mount: "ini", sh: "sh", bash: "sh", zsh: "sh", py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", md: "markdown", markdown: "markdown", xml: "xml", html: "html", htm: "html", css: "css", sql: "sql", go: "go", rs: "rust", lua: "lua", php: "php", rb: "ruby", diff: "diff", patch: "diff" };
  return map[e] ?? null;
}
