/**
 * Names, ids and formats the builder validates, shared by the form (instant feedback) and the
 * server (the real gate). Keep every rule here so both sides agree.
 */

/** Docker image references: [registry[:port]/]name[/name…][:tag][@sha256:digest]. */
const LABEL = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
const DOMAIN = `(?:(?:localhost|${LABEL}(?:\\.${LABEL})+)(?::[0-9]{1,5})?/|${LABEL}:[0-9]{1,5}/)?`;
const COMP = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_RE = new RegExp(`^${DOMAIN}${COMP}(?:/${COMP})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`);

export function imageError(ref: string): string | null {
  const r = ref.trim();
  if (!r) return "Enter an image, like jellyfin/jellyfin or ghcr.io/owner/app:1.2.";
  if (r.length > 255) return "That image name is too long.";
  if (/\s/.test(r)) return "Image names can't contain spaces.";
  if (/^https?:\/\//i.test(r)) return "Enter the image name without https://, like ghcr.io/owner/app.";
  if (r.includes("$")) return null; // uses a compose variable; checked when published
  if (!IMAGE_RE.test(r)) {
    if (/[A-Z]/.test(r.split("/").pop()!.split(":")[0]!)) return "Image names are lowercase.";
    return "That doesn't look like an image name. Use name, name:tag or registry/name:tag.";
  }
  return null;
}

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string | null;
  digest: string | null;
}

/** Split an image reference the way Docker does (docker.io/library/ for bare names). */
export function parseImage(ref: string): ImageRef {
  let rest = ref.trim();
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const first = rest.split("/")[0]!;
  let registry = "docker.io";
  if (rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    registry = first;
    rest = rest.slice(first.length + 1);
  }
  if (registry === "docker.io" && !rest.includes("/")) rest = `library/${rest}`;
  return { registry, repository: rest, tag, digest };
}

/** Images Gluon built on this server. They never come from a registry. */
export const LOCAL_REGISTRY = "gluon.local";
export const isLocalImage = (ref: string) => ref.startsWith(`${LOCAL_REGISTRY}/`);

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function envNameError(name: string): string | null {
  if (!name) return "Give the variable a name.";
  if (name.length > 128) return "That name is too long.";
  if (!ENV_NAME_RE.test(name)) return "Use letters, digits and _ (not starting with a digit).";
  return null;
}

/** A value an env file or compose can carry. */
export function envValueError(value: string): string | null {
  if (value.length > 32_768) return "That value is too long.";
  if (value.includes("\0")) return "Values can't contain a NUL character.";
  return null;
}

export const SERVICE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Service names Umbrel uses for its own containers. */
export const RESERVED_SERVICES = new Set(["app_proxy", "tor_server", "tor"]);
export function serviceNameError(name: string): string | null {
  if (!name) return "Give the service a name.";
  if (!SERVICE_RE.test(name)) return "Use lowercase letters, digits, - and _ (up to 40).";
  if (RESERVED_SERVICES.has(name)) return `Umbrel uses “${name}” for its own container. Pick another name.`;
  return null;
}

/** Lowercase a-z, 0-9 and - id from any name, including accented and non-Latin ones. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return s || "app";
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export function slugError(slug: string): string | null {
  if (!slug) return "Give the app an id.";
  if (!SLUG_RE.test(slug)) return "Use lowercase letters, digits and - (up to 30, not starting or ending with -).";
  return null;
}

export const STORE_ID_RE = /^[a-z][a-z0-9]{1,15}$/;

/** Umbrel app ids start with the store's id. */
export const umbrelAppId = (storeId: string, slug: string) => `${storeId}-${slug}`;

export function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the app a name.";
  if (n.length > 60) return "Keep the name under 60 characters; Umbrel cuts long names off.";
  return null;
}

export function taglineError(t: string): string | null {
  if (t.length > 120) return "Keep the tagline under 120 characters.";
  return null;
}

export function urlError(u: string, what = "address"): string | null {
  const v = u.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" && url.protocol !== "http:") return `The ${what} should start with https:// or http://.`;
    return null;
  } catch {
    return `That isn't a full web address. Include https://.`;
  }
}

const ICON_DATA_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml)(;base64)?,/;
export const MAX_ICON_BYTES = 256 * 1024;
export function iconError(icon: string | null): string | null {
  if (!icon) return null;
  if (icon.startsWith("data:")) {
    if (!ICON_DATA_RE.test(icon)) return "Icons can be PNG, JPEG, WebP, GIF or SVG.";
    if (icon.length > MAX_ICON_BYTES * 1.4) return "That icon is too big. Use one under 256 KB.";
    return null;
  }
  if (icon.length > 2048) return "That icon address is too long.";
  return urlError(icon, "icon address");
}

export function portError(p: number | null | undefined, what = "Port"): string | null {
  if (p === null || p === undefined || Number.isNaN(p)) return `${what} is missing.`;
  if (!Number.isInteger(p) || p < 1 || p > 65535) return `${what} must be a whole number from 1 to 65535.`;
  return null;
}

/** Absolute host folder for a bind mount. */
export function hostPathError(p: string): string | null {
  if (!p) return "Choose a folder.";
  if (!p.startsWith("/")) return "Use a full path starting with /.";
  if (p.includes("\0") || /(^|\/)\.\.(\/|$)/.test(p)) return "That path isn't allowed.";
  if (p.includes("$")) return null; // a compose variable, e.g. ${APP_DATA_DIR}
  if (p.length > 1024) return "That path is too long.";
  if (p.includes(":")) return "Paths with : can't be mounted this way.";
  return null;
}

/** Folder inside the app's data folder: "config", "db/data". */
export function dataFolderError(p: string): string | null {
  if (!p) return "Name the folder.";
  if (p.startsWith("/") || /(^|\/)\.\.?(\/|$)/.test(p) || p.includes("\0") || p.includes(":") || p.includes("$")) return "Use a simple folder name, like config.";
  if (p.length > 200) return "That name is too long.";
  return null;
}

export function containerPathError(p: string): string | null {
  if (!p) return "Enter where it appears inside the app, like /config.";
  if (!p.startsWith("/")) return "Container paths start with /.";
  if (p.includes(":") || p.includes("\0")) return "That path isn't allowed.";
  return null;
}

/** Sizes compose understands for mem_limit: 512m, 2g, 1.5gb. */
export function memoryError(m: string): string | null {
  if (!m) return null;
  if (!/^\d+(\.\d+)?\s*([kmg]i?b?)$/i.test(m.trim())) return "Use a size like 512m or 2g.";
  return null;
}

export const DEVICE_RE = /^\/dev\/[A-Za-z0-9._\/-]+(:\/dev\/[A-Za-z0-9._\/-]+)?(:[rwm]{1,3})?$/;

export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<!\/)(?<!\.lock)$/;

/** "owner/repo", "https://github.com/owner/repo[.git][/tree/branch/path]" → parts. */
export function parseGithub(input: string): { owner: string; repo: string; branch: string | null; path: string | null } | null {
  let v = input.trim();
  if (!v) return null;
  v = v.replace(/^git@github\.com:/i, "https://github.com/");
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/([^\s#?]*))?)?\/?(?:[#?].*)?$/i.exec(v);
  if (!m) m = /^([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(v);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo, branch: m[3] ? decodeURIComponent(m[3]) : null, path: m[4] ? decodeURIComponent(m[4]).replace(/\/$/, "") : null };
}

export function repoPathError(p: string): string | null {
  if (!p) return null;
  if (p.startsWith("/") || /(^|\/)\.\.?(\/|$)/.test(p) || p.includes("\0") || p.length > 300) return "Use a folder inside the repository, like apps/web.";
  return null;
}

/** LinuxServer images (linuxserver/…, lscr.io/linuxserver/…) run as PUID/PGID, in the timezone TZ names. */
export const isLinuxServerImage = (image: string) => /(^|\/)linuxserver\/|^lscr\.io\//.test(image.trim());

/** The variables LinuxServer images read, with this server's usual answers. */
export function linuxServerEnv(timeZone?: string): { key: string; value: string }[] {
  let tz = timeZone;
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = undefined;
    }
  }
  return [
    { key: "PUID", value: "1000" },
    { key: "PGID", value: "1000" },
    { key: "TZ", value: tz || "Etc/UTC" },
  ];
}

const FOLDER_NOISE = new Set(["var", "lib", "usr", "src", "app", "opt", "srv", "home", "share"]);

/**
 * The app-data folder a container path gets: /config → config, /var/lib/mysql → mysql,
 * /data/tvshows → data-tvshows. `taken` keeps two paths from sharing a folder.
 */
export function dataFolderFor(containerPath: string, taken?: Set<string>): string {
  const base =
    containerPath
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((p) => p && !FOLDER_NOISE.has(p))
      .slice(-2)
      .join("-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "") || "data";
  if (!taken) return base;
  let f = base;
  for (let n = 2; taken.has(f); n++) f = `${base}-${n}`;
  taken.add(f);
  return f;
}

/** Folder names that hold a media library, by what people call the library. */
const MEDIA: [RegExp, string][] = [
  [/^(music|songs)([-_ ]?library)?$/, "music"],
  [/^(movies?|films?)$/, "movies"],
  [/^(tv|tv[-_ ]?shows?|shows|series|anime)$/, "TV"],
  [/^(videos?|recordings)$/, "videos"],
  [/^(photos?|pictures)$/, "photos"],
  [/^e?books$/, "books"],
  [/^audio[-_ ]?books$/, "audiobooks"],
  [/^podcasts?$/, "podcasts"],
  [/^(comics|manga)$/, "comics"],
  [/^(downloads?|torrents)$/, "downloads"],
  [/^media$/, "media"],
];

/**
 * What a container path holds when it's a media library (/music, /data/movies, /tv), else null.
 * Gluon never puts these in app data on its own: app data is deleted with the app.
 */
export function mediaKind(containerPath: string): string | null {
  const last = containerPath.replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? "";
  for (const [re, word] of MEDIA) if (re.test(last)) return word;
  return null;
}

/** CPU limit in cores, like compose's cpus: 0.5, 2. */
export function cpusError(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) return "Use a number of cores, like 0.5 or 2.";
  if (Number(t) > 1024) return "That's more cores than any server has.";
  return null;
}

/** Compose durations: 30s, 1m30s, 500ms, 2h. */
export function durationError(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(t)) return "Use a duration like 30s, 2m or 1m30s.";
  return null;
}

/** Docker network names. */
export const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export function networkNameError(n: string): string | null {
  if (!n) return "Name the network.";
  if (!NETWORK_RE.test(n)) return "Use letters, digits, ., _ and - (up to 63).";
  return null;
}

/** Label keys: reverse-DNS style, like com.example.role or traefik.enable. */
export function labelKeyError(k: string): string | null {
  if (!k) return "Give the label a name.";
  if (k.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(k)) return "Use letters, digits, ., /, _ and -.";
  return null;
}

/** Secret-looking variable names start out hidden. */
export const looksSecret = (name: string) => /(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|_KEY$|^KEY$|SALT|AUTH)/i.test(name);

/** Split a command line like a shell would (quotes, backslashes), without expanding anything. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1]!)) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function shellJoin(args: string[]): string {
  return args.map((a) => (a && /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
