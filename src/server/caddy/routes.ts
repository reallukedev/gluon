import "server-only";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { AppError } from "../errors";

/**
 * routes.json is the source of truth. Every save renders a Caddyfile and loads it through the admin
 * unix socket (atomic: Caddy keeps the old config on error) before both files are persisted.
 * Format-compatible with the original Domains app.
 */

export const CADDY_DIR = (process.env.GLUON_CADDY_DIR ?? process.env.TEND_CADDY_DIR) ?? "/proxy-caddy";
export const ADMIN_SOCKET = (process.env.GLUON_CADDY_SOCKET ?? process.env.TEND_CADDY_SOCKET) ?? "/run/caddy/admin.sock";
const ROUTES_FILE = path.join(CADDY_DIR, "routes.json");
const CADDYFILE = path.join(CADDY_DIR, "Caddyfile");
const HISTORY_DIR = path.join(CADDY_DIR, "history");
const HISTORY_KEEP = 40;
export const CERTS_DIR = path.join(CADDY_DIR, "certs");
/** Where Caddy's container sees Gluon's Caddy folder (read-only bind of the same host folder). */
export const DEFAULT_CADDY_MOUNT = "/etc/caddy";
const MOUNT_RE = /^(\/[A-Za-z0-9._-]+)+$/;
let caddyMount = (() => {
  const env = process.env.GLUON_CADDY_MOUNT;
  return env && MOUNT_RE.test(env) ? env : DEFAULT_CADDY_MOUNT;
})();
export function setCaddyMount(p: string) {
  if (MOUNT_RE.test(p)) caddyMount = p;
}
export const currentCaddyMount = () => caddyMount;
export const THIS_SERVER = "host.docker.internal";
export const GLUON_PORT = Number(process.env.PORT ?? "8130");
const LOCAL_HOSTS = new Set([THIS_SERVER, "localhost", "127.0.0.1", "::1"]);
/** A backend that is Gluon itself. */
export const isGluonBackend = (b: Backend) => LOCAL_HOSTS.has(b.host) && b.port === GLUON_PORT;

export interface Backend {
  host: string;
  port: number;
  tls: boolean;
}

interface Base {
  id: string;
  name: string;
  enabled: boolean;
  app?: string;
  note?: string;
}
/** Paths on a subdomain served by a different backend (e.g. an app's admin behind another login). */
export interface ExtraPaths {
  paths: string[];
  backend: Backend;
  note?: string;
}
export interface SubdomainRoute extends Base {
  type: "subdomain";
  host: string;
  backend: Backend;
  only_paths?: string[];
  extra_paths?: ExtraPaths[];
  /** An XMPP chat server: `host` is its domain, `backend` its client (c2s) port. */
  xmpp?: XmppSettings;
  /** The whole host redirects here (keeping the path); `backend` is then unused. */
  redirect_to?: string;
  /** A voice server (Mumble): apps connect straight to `voice.port`; the web address shows a page with a mumble:// link. */
  voice?: VoiceSettings;
  /** Who handles HTTPS for this name. Absent: Caddy gets a certificate on its own. */
  https?: HttpsSettings;
  /** A site from Gluon's Sites: Caddy serves one published version's files itself; `backend` is then Caddy's own port. */
  site?: SiteRef;
  /** With Cloudflare connected: skip its proxy, with a DNS record straight at this network (video, big uploads). */
  direct?: boolean;
}

export interface SiteRef {
  id: string;
  version: string;
  /** The version has its own 404.html, shown for anything it doesn't have. */
  own_404?: boolean;
}

export const SITE_ID_RE = /^[a-z0-9]{6,32}$/;
export const SITE_VERSION_RE = /^\d{8}T\d{6}Z(-\d{1,3})?$/;
/**
 * Its backend names Caddy's own HTTPS port, so checks that look at "the app" see the web server that
 * really answers instead of a port nothing listens on.
 */
export const SITE_BACKEND: Backend = { host: THIS_SERVER, port: 443, tls: false };
export const siteRoot = (site: Pick<SiteRef, "id" | "version">, mount = caddyMount) => `${mount}/sites/${site.id}/${site.version}`;

export interface VoiceSettings {
  /** Mumble's port (TCP and UDP), usually 64738. */
  port: number;
}

/**
 * own: a certificate the person supplies, stored in ./certs next to the Caddyfile (copied from
 * `files` whenever those change). http: a proxy, tunnel or load balancer in front handles HTTPS.
 * none: chat addresses only, so Caddy never asks for a certificate.
 */
export type HttpsMode = "auto" | "own" | "http" | "none";
export interface HttpsSettings {
  mode: Exclude<HttpsMode, "auto">;
  files?: { cert: string; key: string };
}

export const httpsMode = (r: Route | null | undefined): HttpsMode => (r?.type === "subdomain" && r.https ? r.https.mode : "auto");

export const MUMBLE_PORT = 64738;

export function ownCertFiles(host: string): { crt: string; key: string } {
  return { crt: path.join(CERTS_DIR, `${host}.crt`), key: path.join(CERTS_DIR, `${host}.key`) };
}

/** A short link on the base domain, or a whole subdomain that redirects. */
export function isRedirect(r: Route | null | undefined): r is RedirectRoute | (SubdomainRoute & { redirect_to: string }) {
  return !!r && (r.type === "redirect" || (r.type === "subdomain" && !!r.redirect_to));
}
export interface XmppSettings {
  s2s_port: number | null;
  http_port: number | null;
  cert_sync: { container: string; dir: string } | null;
}

export const XMPP_C2S_PORT = 5222;
export const XMPP_S2S_PORT = 5269;
export interface PathRoute extends Base {
  type: "path";
  path: string;
  backend: Backend;
  strip_prefix: boolean;
}
export interface RedirectRoute extends Base {
  type: "redirect";
  path: string;
  target: string;
}
export type Route = SubdomainRoute | PathRoute | RedirectRoute;

export interface RoutesConfig {
  base_domain: string;
  fallback: { name: string; app?: string | null; backend: Backend };
  routes: Route[];
  updated?: string;
}

export function readConfig(): RoutesConfig {
  const raw = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8")) as RoutesConfig;
  return raw;
}

export function tryReadConfig(): RoutesConfig | null {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

export function configRev(cfg: RoutesConfig): string {
  return crypto.createHash("sha256").update(stableStringify({ base_domain: cfg.base_domain, fallback: cfg.fallback, routes: cfg.routes })).digest("hex").slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Plain-HTTP names are http://; whatever is in front may still add HTTPS. */
export function routeUrl(cfg: RoutesConfig, r: Route): string {
  return r.type === "subdomain" ? `${httpsMode(r) === "http" ? "http" : "https"}://${r.host}` : `https://${cfg.base_domain}${r.path}`;
}

const HEAD = `# Caddy config for __BASE__, generated by Gluon (Network → Public addresses).
#
# Do not edit by hand: the next save in Gluon overwrites this file (the previous
# copy goes to ./history). Routes live in ./routes.json.
#
# Backends on this host are reached via host.docker.internal:<host port>.
# Only hostnames/paths listed here are reachable from the internet.
{
	# Local-only admin API on a unix socket shared with Gluon, which uses it to
	# apply changes without downtime. Nothing listens on :2019.
	admin unix//run/caddy/admin.sock

	servers {
		# __BASE__ is proxied by Cloudflare. Trust its ranges
		# (https://www.cloudflare.com/ips/) so logs and backends see the real
		# visitor IP instead of a Cloudflare edge address.
		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
		client_ip_headers CF-Connecting-IP X-Forwarded-For
	}
}

(common) {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
	log {
		output stdout
		format json
	}
}
`;

/**
 * What strangers see on an address that publishes only some paths. It names nothing behind it (no app,
 * port or path list). The host comes in as a snippet argument at load time, never from the request.
 * Browsers get a page; API clients and anything but GET/HEAD get an empty 404, as before, since an
 * HTML body would only confuse them.
 */
export const NOT_PUBLISHED_HTML = [
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#f4f3ef" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)"><title>Nothing here</title>',
  "<style>",
  ":root{color-scheme:light dark;--bg:#f4f3ef;--ink:#18181a;--ink2:#45443f;--muted:#6b6962;--faint:#9a978e;--line:#dddbd4}",
  "@media (prefers-color-scheme:dark){:root{--bg:#111214;--ink:#ece7db;--ink2:#bdb8ac;--muted:#918d83;--faint:#6a675f;--line:#26272b}}",
  "body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-text-size-adjust:100%}",
  "main{max-width:32rem;margin:0 auto;padding:18vh 1.5rem 3rem}",
  "svg{display:block;width:77px;height:35px;margin:0 0 1rem -1px;color:var(--faint)}",
  "h1{margin:0;text-wrap:balance;font-size:1.75rem;line-height:1.1;font-weight:560;font-stretch:88%;letter-spacing:-.01em}",
  "p{margin:.5rem 0 0;color:var(--ink2)}",
  ".at{margin-top:2.25rem;padding-top:.75rem;border-top:1px solid var(--line);color:var(--muted);font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}",
  "</style>",
  '<main><svg viewBox="0 0 44 20" fill="none" aria-hidden="true"><circle cx="3" cy="14" r="2.4" fill="currentColor"/><path d="M3 14L4.5 13.9L5.8 13.4L7.1 12.8L8.1 11.9L8.9 10.9L9.4 9.8L9.7 8.7L9.6 7.7L9.3 6.8L8.8 6.2L8.2 5.7L7.5 5.6L6.8 5.7L6.2 6.2L5.7 6.8L5.4 7.7L5.3 8.7L5.5 9.8L6.1 10.9L6.9 11.9L7.9 12.8L9.2 13.4L10.5 13.9L12 14L13.5 13.9L14.8 13.4L16.1 12.8L17.1 11.9L17.9 10.9L18.4 9.8L18.7 8.7L18.6 7.7L18.3 6.8L17.9 6.2L17.2 5.7L16.5 5.6L15.8 5.7L15.2 6.2L14.7 6.8L14.4 7.7L14.3 8.7L14.6 9.8L15.1 10.9L15.9 11.9L16.9 12.8L18.1 13.4L19.5 13.9L21 14" stroke-linejoin="round" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M24 14H37.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="0.1 3.2"/><circle cx="41" cy="14" r="2.4" stroke="currentColor" stroke-width="1.3" stroke-dasharray="1.6 1.4"/></svg>',
  "<h1>Nothing here</h1>",
  "<p>There’s no page at this link.</p>",
  '<p class="at" translate="no">404 · {args[0]}</p></main>',
];

const NOT_PUBLISHED_SNIPPET = [
  "# Paths an address doesn't publish: a plain page for browsers that names nothing",
  "# behind it, and an empty 404 for API clients.",
  "(not_published) {",
  "\theader Cache-Control no-store",
  "\theader X-Robots-Tag noindex",
  "\t@browser {",
  "\t\tmethod GET HEAD",
  "\t\theader Accept *text/html*",
  "\t}",
  "\thandle @browser {",
  '\t\theader Content-Type "text/html; charset=utf-8"',
  "\t\theader Content-Security-Policy \"default-src 'none'; style-src 'unsafe-inline'\"",
  "\t\trespond <<HTML",
  ...NOT_PUBLISHED_HTML.map((l) => `\t\t${l}`),
  "\t\tHTML 404",
  "\t}",
  "\thandle {",
  "\t\trespond 404",
  "\t}",
  "}",
  "",
].join("\n");

const commentSafe = (t: string) => t.replace(/[^\w .,:;&()'/+*?!-]/g, "").slice(0, 80);

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  return cur ? [...lines, cur] : lines;
}
const noteLines = (r: Route, prefix: string) => (r.note ? wrap(r.note, 76).map((l) => `${prefix}# ${commentSafe(l)}`) : []);

function backendLines(b: Backend, indent: number): string[] {
  const t = "\t".repeat(indent);
  const addr = `${b.host}:${b.port}`;
  if (b.tls) return [`${t}reverse_proxy https://${addr} {`, `${t}\ttransport http {`, `${t}\t\ttls_insecure_skip_verify`, `${t}\t}`, `${t}}`];
  return [`${t}reverse_proxy ${addr}`];
}

export const coveredByWildcard = (host: string, base: string) => host.endsWith(`.${base}`) && !host.slice(0, -base.length - 1).includes(".");

/** Routes that are off or only redirect don't count. */
export function publicPorts(cfg: RoutesConfig): Map<number, string> {
  const out = new Map<number, string>();
  const add = (b: Backend, where: string) => {
    if (b.host === THIS_SERVER && !out.has(b.port)) out.set(b.port, where);
  };
  for (const r of cfg.routes) {
    if (r.enabled === false || isRedirect(r)) continue;
    // A site is served by Caddy itself; no port on this server is reached through it.
    if (r.type === "subdomain" && r.site) continue;
    const where = routeUrl(cfg, r).replace(/^https?:\/\//, "").replace(/\/$/, "");
    // Chat and voice ports are reached directly, not through Caddy; only a chat server's web side is.
    if (r.type === "subdomain" && (r.xmpp || r.voice)) {
      if (r.xmpp?.http_port && httpsMode(r) !== "none") add({ ...r.backend, port: r.xmpp.http_port }, where);
      continue;
    }
    add(r.backend, r.type === "subdomain" && r.only_paths?.length ? `${where}${r.only_paths[0]!.replace(/\/?\*$/, "")}` : where);
    if (r.type === "subdomain") for (const x of r.extra_paths ?? []) add(x.backend, `${r.host}${x.paths[0]?.replace(/\/?\*$/, "") ?? ""}`);
  }
  add(cfg.fallback.backend, cfg.base_domain);
  return out;
}

/** Routes limited to some paths are left out: the tile would open a page the route doesn't publish. */
export function appLinks(routes: Route[]): [number, string][] {
  const links = new Map<number, string>();
  for (const r of routes) {
    if (r.type !== "subdomain" || r.redirect_to || r.voice || r.site || httpsMode(r) === "none") continue;
    const url = `${httpsMode(r) === "http" ? "http" : "https"}://${r.host}`;
    // A chat server's client port speaks XMPP, not HTTP: only its web side gets a tile link.
    const port = r.xmpp ? r.xmpp.http_port : r.only_paths?.length ? null : r.backend.port;
    if (port && r.backend.host === THIS_SERVER && !links.has(port)) links.set(port, url);
    for (const x of r.extra_paths ?? []) {
      if (x.backend.host === THIS_SERVER && !links.has(x.backend.port)) links.set(x.backend.port, url);
    }
  }
  return [...links.entries()].sort((a, b) => a[0] - b[0]);
}

export function renderCaddyfile(cfg: RoutesConfig, mount = caddyMount): string {
  const base = cfg.base_domain;
  const routes = cfg.routes.filter((r) => r.enabled !== false);
  const out: string[] = [HEAD.replaceAll("__BASE__", base)];
  const paths = routes
    .filter((r): r is PathRoute | RedirectRoute => r.type !== "subdomain")
    .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  out.push("# Proxied through Cloudflare (orange cloud): hides this network's IP, but");
  out.push("# uploads are capped at 100 MB and video streaming breaks Cloudflare's ToS.");
  out.push(`${base} {`, "\timport common", "");
  // CasaOS's /js/custom.js and Umbrel's /tile-links.js load this map so app tiles opened on the
  // public domain go to each app's public address instead of the LAN address:port.
  const links = appLinks(routes)
    .map(([port, url]) => `[${port}, "${url}"]`)
    .join(", ");
  const tileMap = [
    "\thandle /_domains/app-links.js {",
    '\t\theader Content-Type "text/javascript; charset=utf-8"',
    `\t\trespond \`window.__casaosAppLinks = ["${base}", [${links}]];\` 200`,
    "\t}",
  ];
  out.push(
    "\t# Dashboard app tiles (CasaOS, Umbrel) open the server's LAN address:port.",
    "\t# CasaOS's /js/custom.js (and Umbrel's /tile-links.js) load this map and",
    "\t# send tiles to their public address instead.",
    "\t@casaos_tiles path /js/custom.js /_domains/app-links.js",
    "\theader @casaos_tiles >Cache-Control no-store",
    ...tileMap,
    "",
  );
  // Caddy refuses a site that defines one matcher name twice, and /a-b and /a.b both become @route_a_b.
  const matchers = new Set<string>();
  let notPublished = false;
  for (const r of paths) {
    const p = r.path;
    out.push(`\t# ${commentSafe(r.name)}`, ...noteLines(r, "\t"));
    if (r.type === "redirect") {
      out.push(`\t# ${p}/<rest> -> ${r.target}/<rest>`, `\tredir ${p} ${r.target}/ 302`, `\thandle_path ${p}/* {`, `\t\tredir ${r.target}{uri} 302`, "\t}");
    } else if (r.strip_prefix) {
      out.push(`\t# App has no base-URL setting: ${p} is stripped before proxying`, `\tredir ${p} ${p}/ 308`, `\thandle_path ${p}/* {`, ...backendLines(r.backend, 2), "\t}");
    } else {
      const want = "@route_" + p.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]/g, "_");
      let m = want;
      for (let i = 2; matchers.has(m); i++) m = `${want}_${i}`;
      matchers.add(m);
      out.push(`\t# App's base-URL setting must be ${p}`, `\t${m} path ${p} ${p}/*`, `\thandle ${m} {`, ...backendLines(r.backend, 2), "\t}");
    }
    out.push("");
  }
  out.push(`\t# Everything else -> ${commentSafe(cfg.fallback.name)}`, "\thandle {", ...backendLines(cfg.fallback.backend, 2), "\t}", "}");
  for (const r of routes.filter((r): r is SubdomainRoute => r.type === "subdomain").sort((a, b) => a.host.localeCompare(b.host))) {
    const mode = httpsMode(r);
    const dns = coveredByWildcard(r.host, base) ? "The wildcard DNS record covers it (A + AAAA)" : "Needs its own DNS record";
    out.push("", `# ${commentSafe(r.name)}. ${dns}.`, ...noteLines(r, ""));
    if (mode === "none" && r.xmpp) {
      // Not a site at all, so Caddy never asks for a certificate (the domain's website may live elsewhere).
      out.push(`# A chat server with no web side here: chat apps connect straight to port ${r.backend.port}`, "# and it handles its own certificate.");
      continue;
    }
    const open = siteOpen(r, mode, mount);
    if (r.site) {
      out.push(...siteFileLines(r.site, open, mount));
      continue;
    }
    if (r.redirect_to) {
      out.push(`# Everything here redirects to ${r.redirect_to}, keeping the path.`, ...open, `\tredir ${r.redirect_to}{uri} 302`, "}");
      continue;
    }
    if (r.xmpp) {
      out.push(...xmppSiteLines(r, r.xmpp, tileMap, open));
      continue;
    }
    if (r.voice) {
      out.push(...voiceSiteLines(r, r.voice, open));
      continue;
    }
    out.push(...open);
    out.push("", "\t# App-tile map for dashboards served here (see the base domain block).", "\theader /_domains/app-links.js >Cache-Control no-store", ...tileMap);
    (r.extra_paths ?? []).forEach((x, i) => {
      const note = x.note ? wrap(x.note, 76).map((l) => `\t# ${commentSafe(l)}`) : [];
      out.push("", ...note, `\t@extra_${i} path ${x.paths.join(" ")}`, `\thandle @extra_${i} {`, ...backendLines(x.backend, 2), "\t}");
    });
    if (r.only_paths?.length) {
      out.push(
        "",
        "\t# Only these paths are published; everything else is a 404.",
        `\t@published path ${r.only_paths.join(" ")}`,
        "\thandle @published {",
        ...backendLines(r.backend, 2),
        "\t}",
        "",
        "\thandle {",
        `\t\timport not_published ${r.host}`,
        "\t}",
      );
      notPublished = true;
    } else out.push("", "\thandle {", ...backendLines(r.backend, 2), "\t}");
    out.push("}");
  }
  // Caddy needs a snippet defined before it's imported.
  if (notPublished) out.splice(1, 0, NOT_PUBLISHED_SNIPPET);
  return out.join("\n") + "\n";
}

/**
 * XMPP itself never goes through Caddy; this block exists so Caddy holds a certificate for the domain
 * (which Gluon copies into the chat server) and fronts its HTTP side.
 */
function xmppSiteLines(r: SubdomainRoute, x: XmppSettings, tileMap: string[], open: string[]): string[] {
  const h = r.host;
  const mode = httpsMode(r);
  const scheme = mode === "http" ? "http" : "https";
  const ports = [`${r.backend.port}`, ...(x.s2s_port ? [`other servers to ${x.s2s_port}`] : [])].join(" and ");
  const out = [
    `# Chat apps connect straight to port ${ports}, not through Caddy.`,
    mode === "http" ? "# Plain HTTP here: whatever is in front handles HTTPS." : mode === "own" ? "# Caddy serves your own certificate for it." : "# Caddy holds the certificate Gluon copies into the chat server.",
    ...open,
    "",
    "\t# App-tile map for dashboards served here (see the base domain block).",
    "\theader /_domains/app-links.js >Cache-Control no-store",
    ...tileMap,
    "",
  ];
  if (x.http_port) {
    const bosh = `${scheme}://${h}/http-bind`;
    const ws = `${scheme === "http" ? "ws" : "wss"}://${h}/xmpp-websocket`;
    out.push(
      "\t# Web chat apps look up the connection endpoints here (XEP-0156).",
      "\t@xmpp_discovery path /.well-known/host-meta /.well-known/host-meta.json",
      '\theader @xmpp_discovery Access-Control-Allow-Origin "*"',
      "\thandle /.well-known/host-meta {",
      '\t\theader Content-Type "application/xrd+xml; charset=utf-8"',
      `\t\trespond \`<?xml version='1.0' encoding='utf-8'?><XRD xmlns='http://docs.oasis-open.org/ns/xri/xrd-1.0'><Link rel='urn:xmpp:alt-connections:xbosh' href='${bosh}'/><Link rel='urn:xmpp:alt-connections:websocket' href='${ws}'/></XRD>\` 200`,
      "\t}",
      "\thandle /.well-known/host-meta.json {",
      '\t\theader Content-Type "application/json"',
      `\t\trespond \`{"links":[{"rel":"urn:xmpp:alt-connections:xbosh","href":"${bosh}"},{"rel":"urn:xmpp:alt-connections:websocket","href":"${ws}"}]}\` 200`,
      "\t}",
      "",
      // No request_body limit and the Host header passes through as-is: file uploads (XEP-0363)
      // can be large and the chat server sets its own CORS headers on them.
      "\t# BOSH, WebSocket and file uploads: the chat server's own web port.",
      "\thandle {",
      ...backendLines({ host: r.backend.host, port: x.http_port, tls: false }, 2),
      "\t}",
    );
  } else {
    out.push(
      "\thandle {",
      '\t\theader Content-Type "text/plain; charset=utf-8"',
      `\t\trespond "${h} is a chat server. Sign in with any XMPP app as you@${h}." 200`,
      "\t}",
    );
  }
  out.push("}");
  return out;
}

/**
 * Each version folder is complete and never changes, so a publish or a rollback is only this block
 * pointing somewhere else.
 */
function siteFileLines(site: SiteRef, open: string[], mount: string): string[] {
  const root = siteRoot(site, mount);
  // Pages (index, .html, and clean URLs with no extension) are checked every visit so a publish shows
  // at once; other files may be reused for a few minutes and are cheap to revalidate after that.
  const pages = "\\.html?$|/[^/.]*$";
  return [
    `# A site from Gluon (Sites), version ${site.version}. Its files are served as they are.`,
    ...open,
    `\troot * ${root}`,
    "\theader X-Frame-Options SAMEORIGIN",
    `\t@pages path_regexp ${pages}`,
    '\theader @pages Cache-Control "no-cache"',
    `\t@assets not path_regexp ${pages}`,
    '\theader @assets Cache-Control "public, max-age=300"',
    "",
    "\t# Clean URLs: /about serves about.html when there's no file or folder called about.",
    "\ttry_files {path} {path}.html",
    "\tfile_server",
    "",
    "\thandle_errors {",
    // Error answers skip the headers above; a missing file mustn't stay cached once it's published.
    "\t\theader {",
    '\t\t\tCache-Control "no-cache"',
    '\t\t\tX-Content-Type-Options "nosniff"',
    '\t\t\tReferrer-Policy "strict-origin-when-cross-origin"',
    "\t\t}",
    ...(site.own_404
      ? [
          "\t\t@missing expression `{err.status_code} == 404`",
          "\t\thandle @missing {",
          `\t\t\troot * ${root}`,
          "\t\t\trewrite * /404.html",
          "\t\t\tfile_server {",
          "\t\t\t\tstatus 404",
          "\t\t\t}",
          "\t\t}",
        ]
      : []),
    "\t\thandle {",
    '\t\t\theader Content-Type "text/plain; charset=utf-8"',
    '\t\t\trespond "{err.status_code} {err.status_text}"',
    "\t\t}",
    "\t}",
    "}",
  ];
}

function siteOpen(r: SubdomainRoute, mode: HttpsMode, mount: string): string[] {
  const out = [`${mode === "http" ? "http://" : ""}${r.host} {`, "\timport common"];
  if (mode === "own") out.push(`\ttls ${mount}/certs/${r.host}.crt ${mount}/certs/${r.host}.key`);
  return out;
}

/**
 * Mumble never goes through Caddy; this block keeps a certificate for the name (Mumble can use it)
 * and tells browsers how to connect instead of proxying them to a port that only speaks Mumble.
 */
function voiceSiteLines(r: SubdomainRoute, v: VoiceSettings, open: string[]): string[] {
  const h = r.host;
  const link = `mumble://${h}${v.port === MUMBLE_PORT ? "" : `:${v.port}`}/`;
  const page = [
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">',
    `<title>${h}</title>`,
    '<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem">',
    `<h1 style="font-size:1.3rem;font-weight:600">${h} is a voice server</h1>`,
    `<p><a href="${link}">Open it in Mumble</a></p>`,
    `<p>Or add a server in Mumble with the address <b>${h}</b> and port <b>${v.port}</b>.</p>`,
    "</body></html>",
  ].join("");
  return [
    `# Voice apps (Mumble) connect straight to port ${v.port}, TCP and UDP, not through Caddy.`,
    "# Browsers get a page with a mumble:// link instead.",
    ...open,
    "",
    "\thandle {",
    '\t\theader Content-Type "text/html; charset=utf-8"',
    `\t\trespond \`${page}\` 200`,
    "\t}",
    "}",
  ];
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PATH_RE = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;
const MATCH_RE = /^\/[A-Za-z0-9._~/-]*\*?$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/;

const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIR_RE = /^(\/[A-Za-z0-9._-]+)+$/;
export const PROSODY_CERT_DIR = "/etc/prosody/certs";

function invalid(message: string, routeId?: string, field?: string): never {
  throw new AppError("invalid_route", message, 400, { route: routeId, field });
}

function cleanBackend(b: Partial<Backend> | undefined, rid: string): Backend {
  if (!b) invalid("Choose which app this goes to.", rid, "port");
  const host = String(b.host || THIS_SERVER).trim().toLowerCase();
  const ip = host.match(IPV4_RE);
  if (!(host === THIS_SERVER || HOST_RE.test(host) || LABEL_RE.test(host) || (ip && ip.slice(1).every((o) => Number(o) < 256)))) {
    invalid(`“${host}” isn't a valid backend host.`, rid, "backend_host");
  }
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("Backend port must be between 1 and 65535.", rid, "port");
  return { host, port, tls: !!b.tls };
}

function cleanPort(v: unknown, rid: string, field: string, label: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const port = Number(v);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid(`${label} must be between 1 and 65535.`, rid, field);
  return port;
}

function cleanXmpp(raw: Record<string, unknown>, backend: Backend, rid: string): XmppSettings {
  const s2s = cleanPort(raw.s2s_port, rid, "s2s_port", "The federation port");
  const httpPort = cleanPort(raw.http_port, rid, "http_port", "The chat server's web port");
  if (httpPort !== null && httpPort === backend.port) invalid("The web port can't be the same as the port chat apps connect to.", rid, "http_port");
  if (s2s !== null && s2s === backend.port) invalid("The federation port can't be the same as the port chat apps connect to.", rid, "s2s_port");
  if (s2s !== null && httpPort !== null && s2s === httpPort) invalid("The web port can't be the same as the federation port.", rid, "http_port");
  let sync: XmppSettings["cert_sync"] = null;
  const cs = raw.cert_sync as Record<string, unknown> | null | undefined;
  if (cs && typeof cs === "object") {
    const container = String(cs.container ?? "").trim();
    const dir = String(cs.dir ?? PROSODY_CERT_DIR).trim().replace(/\/+$/, "") || PROSODY_CERT_DIR;
    if (!CONTAINER_RE.test(container)) invalid("Choose which container runs the chat server.", rid, "cert_container");
    if (!DIR_RE.test(dir) || dir.split("/").includes("..")) invalid(`“${dir}” isn't a valid folder inside the container.`, rid, "cert_dir");
    sync = { container, dir };
  }
  return { s2s_port: s2s, http_port: httpPort, cert_sync: sync };
}

const FILE_RE = /^(\/[A-Za-z0-9._@+-]+)+$/;

function cleanFile(v: unknown, rid: string, field: string, what: string): string {
  const p = String(v ?? "").trim();
  if (!FILE_RE.test(p) || p.length > 400 || p.split("/").includes("..")) invalid(`Enter the full path to the ${what} on this server, like /etc/letsencrypt/live/example.com/${what === "key" ? "privkey" : "fullchain"}.pem.`, rid, field);
  return p;
}

type SiteKind = "web" | "chat" | "voice" | "redirect";

function cleanHttps(raw: unknown, rid: string, kind: SiteKind): HttpsSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Record<string, unknown>;
  const mode = h.mode;
  if (mode === undefined || mode === "auto") return undefined;
  if (mode === "http") return { mode };
  if (mode === "none") {
    if (kind !== "chat") invalid("Only a chat server can go without a web side. Choose another way to handle HTTPS.", rid, "https");
    return { mode };
  }
  if (mode !== "own") invalid("Choose how HTTPS is handled for this address.", rid, "https");
  const f = h.files as Record<string, unknown> | null | undefined;
  if (!f || typeof f !== "object") return { mode };
  return { mode, files: { cert: cleanFile(f.cert, rid, "cert_file", "certificate"), key: cleanFile(f.key, rid, "key_file", "key") } };
}

/** Base domain always comes from the stored config. */
export function cleanConfig(raw: { routes: unknown[]; fallback?: RoutesConfig["fallback"] }, current: RoutesConfig): RoutesConfig {
  const base = current.base_domain;
  const fb = raw.fallback ?? current.fallback;
  const cfg: RoutesConfig = {
    base_domain: base,
    fallback: { name: String(fb.name || "CasaOS").slice(0, 60), app: fb.app ?? null, backend: cleanBackend(fb.backend, "fallback") },
    routes: [],
  };
  const hosts = new Set<string>();
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const item of raw.routes) {
    const r = item as Record<string, unknown>;
    let rid = String(r.id ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(rid) || ids.has(rid)) rid = crypto.randomBytes(4).toString("hex");
    ids.add(rid);
    const name = String(r.name ?? "").trim().slice(0, 60);
    if (!name) invalid("Give the address a name.", rid, "name");
    const out: Record<string, unknown> = { id: rid, type: r.type, name, enabled: r.enabled !== false };
    const note = String(r.note ?? "").split(/\s+/).join(" ").trim().slice(0, 400);
    if (note) out.note = note;
    if (typeof r.app === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(r.app)) out.app = r.app;
    if (r.type === "subdomain") {
      const host = String(r.host ?? "").trim().toLowerCase().replace(/\.$/, "");
      if (!HOST_RE.test(host)) invalid(`“${host || "(empty)"}” isn't a valid hostname.`, rid, "host");
      if (host === base) invalid(`${base} itself is handled by the path addresses.`, rid, "host");
      if (hosts.has(host)) invalid(`${host} is already used by another address.`, rid, "host");
      hosts.add(host);
      out.host = host;
      out.backend = cleanBackend(r.backend as Partial<Backend>, rid);
      let only = r.only_paths as unknown;
      if (typeof only === "string") only = only.replace(/,/g, " ").split(/\s+/);
      const onlyPaths = (Array.isArray(only) ? only : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
      for (const p of onlyPaths) if (!MATCH_RE.test(p)) invalid(`“${p}” isn't a valid path pattern. Use e.g. /rest/* or /api/health.`, rid, "only_paths");
      if (onlyPaths.length) out.only_paths = onlyPaths;
      const extras = Array.isArray(r.extra_paths) ? (r.extra_paths as Record<string, unknown>[]).slice(0, 10) : [];
      const cleanExtras: ExtraPaths[] = [];
      for (const x of extras) {
        const xp = (Array.isArray(x?.paths) ? x.paths : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
        if (!xp.length) continue;
        for (const p of xp) if (!MATCH_RE.test(p)) invalid(`“${p}” isn't a valid path pattern. Use e.g. /admin/* or /api/health.`, rid, "extra_paths");
        const xn = typeof x.note === "string" ? x.note.trim().slice(0, 500) : "";
        cleanExtras.push({ paths: xp, backend: cleanBackend(x.backend as Partial<Backend>, rid), ...(xn ? { note: xn } : {}) });
      }
      if (cleanExtras.length) out.extra_paths = cleanExtras;
      if (r.site && typeof r.site === "object") {
        const site = r.site as Record<string, unknown>;
        const id = String(site.id ?? "");
        const version = String(site.version ?? "");
        if (!SITE_ID_RE.test(id) || !SITE_VERSION_RE.test(version)) invalid("That site's published version isn't valid. Publish it again from Sites.", rid, "site");
        out.site = { id, version, ...(site.own_404 === true ? { own_404: true } : {}) };
        // Caddy serves the files itself; nothing is proxied and path limits don't apply.
        out.backend = { ...SITE_BACKEND };
        delete out.only_paths;
        delete out.extra_paths;
      } else if (typeof r.redirect_to === "string" && r.redirect_to.trim()) {
        const target = r.redirect_to.trim().replace(/\/+$/, "");
        if (!URL_RE.test(target)) invalid("Redirect target must be a plain http(s):// address.", rid, "redirect_to");
        if (new URL(target).hostname.toLowerCase() === host) invalid("A domain can't redirect to itself.", rid, "redirect_to");
        out.redirect_to = target;
        delete out.only_paths;
        delete out.extra_paths;
      } else if (r.xmpp && typeof r.xmpp === "object") {
        out.xmpp = cleanXmpp(r.xmpp as Record<string, unknown>, out.backend as Backend, rid);
        // A chat server publishes its whole domain; path limits don't apply.
        delete out.only_paths;
        delete out.extra_paths;
      } else if (r.voice && typeof r.voice === "object") {
        const b = out.backend as Backend;
        const port = cleanPort((r.voice as Record<string, unknown>).port, rid, "voice_port", "The voice server's port") ?? b.port;
        out.voice = { port };
        // Apps connect to the voice port itself; keep backend in step so app matching by port works.
        out.backend = { host: b.host, port, tls: false };
        delete out.only_paths;
        delete out.extra_paths;
      }
      const kind: SiteKind = out.redirect_to ? "redirect" : out.xmpp ? "chat" : out.voice ? "voice" : "web";
      // Chat and voice are never proxied; the flag only means something for web names.
      if (r.direct === true && (kind === "web" || kind === "redirect")) out.direct = true;
      const https = cleanHttps(r.https, rid, kind);
      if (https) {
        out.https = https;
        const x = out.xmpp as XmppSettings | undefined;
        if (x && https.mode === "none" && x.http_port !== null) invalid("With no web side here, the chat server's web port can't be published. Turn off web chat, or let Caddy handle HTTPS.", rid, "http_port");
        // Without a certificate in Caddy there's nothing for Gluon to copy into the chat server.
        if (x && (https.mode === "none" || https.mode === "http")) x.cert_sync = null;
      }
    } else if (r.type === "path" || r.type === "redirect") {
      const p = "/" + String(r.path ?? "").trim().replace(/^\/+|\/+$/g, "");
      if (!PATH_RE.test(p)) invalid("Paths can use letters, numbers and . _ ~ - (e.g. /photos).", rid, "path");
      if (paths.has(p.toLowerCase())) invalid(`${base}${p} is already used by another address.`, rid, "path");
      paths.add(p.toLowerCase());
      out.path = p;
      if (r.type === "path") {
        out.backend = cleanBackend(r.backend as Partial<Backend>, rid);
        out.strip_prefix = !!r.strip_prefix;
      } else {
        const target = String(r.target ?? "").trim().replace(/\/+$/, "");
        if (!URL_RE.test(target)) invalid("Redirect target must be a plain http(s):// address.", rid, "target");
        out.target = target;
      }
    } else invalid("Unknown address type.", rid);
    cfg.routes.push(out as unknown as Route);
  }
  assertGluonOwnOrigin(cfg);
  return cfg;
}

/**
 * Paths of the main address all share one origin. When Gluon is served there too, the browser sends
 * Gluon's sign-in cookie to every app on a path and treats their pages as Gluon's own, so any app
 * that serves someone else's script could act as the admin viewing it.
 */
function assertGluonOwnOrigin(cfg: RoutesConfig) {
  const live = cfg.routes.filter((r): r is PathRoute => r.enabled && r.type === "path");
  const gluonHere = isGluonBackend(cfg.fallback.backend) || live.some((r) => isGluonBackend(r.backend));
  if (!gluonHere) return;
  const shared = live.filter((r) => !isGluonBackend(r.backend));
  if (!shared.length) return;
  invalid(
    `Gluon is on ${cfg.base_domain}, so apps on its paths would share Gluon's sign-in. Give Gluon its own subdomain, or turn ${shared.map((r) => r.path).join(", ")} into redirects or subdomains.`,
    shared[0]!.id,
    "path",
  );
}

export class CaddyUnreachable extends AppError {
  constructor(detail: string) {
    super("caddy_unreachable", `Can't reach Caddy (${detail}). Is the proxy stack running?`, 502);
  }
}

export function caddyAdmin(method: string, urlPath: string, body?: string, contentType?: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: ADMIN_SOCKET,
        path: urlPath,
        method,
        // Caddy only accepts Host "", 127.0.0.1 or ::1 on unix-socket admin endpoints.
        headers: { Host: "127.0.0.1", ...(contentType ? { "Content-Type": contentType } : {}), ...extra },
        timeout: 60_000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", (e) => reject(new CaddyUnreachable((e as NodeJS.ErrnoException).code ?? e.message)));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/** `force` reloads even when the text is unchanged, so Caddy re-reads certificate files. */
async function caddyLoad(caddyfile: string, force = false) {
  const r = await caddyAdmin("POST", "/load", caddyfile, "text/caddyfile", force ? { "Cache-Control": "must-revalidate" } : {});
  if (r.status !== 200) {
    let msg = r.body;
    try {
      msg = (JSON.parse(r.body) as { error?: string }).error ?? r.body;
    } catch {
      /* raw */
    }
    throw new AppError("caddy_rejected", `Caddy rejected the change: ${msg.trim().slice(0, 400)}`, 400);
  }
}

export async function caddyRunning(): Promise<boolean> {
  try {
    return (await caddyAdmin("GET", "/config/admin")).status === 200;
  } catch {
    return false;
  }
}

function ownLike(p: string) {
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ CADDY_DIR);
    fs.chownSync(p, st.uid, st.gid);
  } catch {
    /* best effort */
  }
}

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    // On disk before the rename, so a power cut can't leave an empty routes file behind.
    const fd = fs.openSync(tmp, "w", 0o644);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o644);
    ownLike(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* none */
    }
    throw e;
  }
}

function snapshot(reason: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z").replace("T", "T");
  const dir = path.join(HISTORY_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [ROUTES_FILE, CADDYFILE]) if (fs.existsSync(/*turbopackIgnore: true*/ f)) fs.copyFileSync(/*turbopackIgnore: true*/ f, path.join(dir, path.basename(f)));
  fs.writeFileSync(path.join(dir, "reason.txt"), reason);
  for (const p of [HISTORY_DIR, dir, ...fs.readdirSync(dir).map((f) => path.join(dir, f))]) ownLike(p);
  const all = fs.readdirSync(HISTORY_DIR).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) fs.rmSync(path.join(HISTORY_DIR, old), { recursive: true, force: true });
  return dir;
}

export async function reloadCaddy(): Promise<void> {
  await caddyLoad(fs.readFileSync(CADDYFILE, "utf8"), true);
}

export function caddyfileDrift(cfg: RoutesConfig): boolean {
  try {
    return fs.readFileSync(CADDYFILE, "utf8") !== renderCaddyfile(cfg);
  } catch {
    return true;
  }
}

/** Persists only after Caddy accepted, and rolls Caddy back if persisting fails. */
export async function applyConfig(cfg: RoutesConfig, reason: string, opts: { force?: boolean } = {}): Promise<RoutesConfig> {
  const text = renderCaddyfile(cfg);
  const readIf = (f: string) => {
    try {
      return fs.readFileSync(/*turbopackIgnore: true*/ f, "utf8");
    } catch {
      return null;
    }
  };
  const prevRoutes = readIf(ROUTES_FILE);
  const prevCaddyfile = readIf(CADDYFILE);
  try {
    await caddyLoad(text, opts.force);
  } catch (e) {
    // No answer in time: Caddy may be running the new config, so put the last saved one back.
    if (!(e instanceof CaddyUnreachable) || !/timeout/.test(e.message) || prevCaddyfile === null) throw e;
    const back = await caddyLoad(prevCaddyfile).then(
      () => true,
      () => false,
    );
    throw new AppError(
      "caddy_timeout",
      back ? "Caddy didn't confirm the change in time, so Gluon put the last saved addresses back. Nothing changed; try again." : "Caddy didn't confirm the change in time, and didn't answer when Gluon tried to put the last saved addresses back. Check that the proxy is running, then save again.",
      504,
    );
  }
  let snap: string | null = null;
  let routesWritten = false;
  try {
    snap = snapshot(reason);
    const saved = { ...cfg, updated: new Date().toISOString().slice(0, 19) + "Z" };
    atomicWrite(ROUTES_FILE, JSON.stringify(saved, null, 2) + "\n");
    routesWritten = true;
    atomicWrite(CADDYFILE, text);
    return saved;
  } catch (e) {
    // Put routes.json and Caddy back to the last saved state, so the files and Caddy agree again.
    let filesBack = true;
    if (routesWritten) {
      try {
        if (prevRoutes !== null) atomicWrite(ROUTES_FILE, prevRoutes);
        else fs.rmSync(ROUTES_FILE, { force: true });
      } catch {
        filesBack = false;
      }
    }
    let caddyBack = false;
    if (prevCaddyfile !== null) {
      caddyBack = await caddyLoad(prevCaddyfile).then(
        () => true,
        () => false,
      );
    }
    if (snap) fs.rmSync(snap, { recursive: true, force: true });
    const why = (e as Error).message;
    if (filesBack && caddyBack) throw new AppError("persist_failed", `Couldn't save the routes file: ${why}. Nothing changed.`, 500);
    throw new AppError("persist_failed", `Couldn't save the routes file: ${why}. Caddy may be serving the new addresses while the saved files still hold the old ones. Fix the problem, then save again.`, 500);
  }
}

export interface HistoryEntry {
  id: string;
  time: string;
  reason: string;
  hasRoutes: boolean;
}

export function listHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .sort()
    .reverse()
    .flatMap((d) => {
      const m = d.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      if (!m) return [];
      const dir = path.join(HISTORY_DIR, d);
      let reason = "";
      try {
        reason = fs.readFileSync(path.join(dir, "reason.txt"), "utf8").trim();
      } catch {
        /* none */
      }
      return [{ id: d, time: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, reason, hasRoutes: fs.existsSync(path.join(dir, "routes.json")) }];
    });
}

export function readHistoryRoutes(id: string): RoutesConfig {
  if (!/^\d{8}T\d{6}\d*Z$/.test(id)) throw new AppError("not_found", "That snapshot is gone.", 404);
  const p = path.join(HISTORY_DIR, id, "routes.json");
  if (!fs.existsSync(p)) throw new AppError("not_found", "That snapshot is gone.", 404);
  return JSON.parse(fs.readFileSync(p, "utf8")) as RoutesConfig;
}

export function readCaddyfile(): string {
  return fs.readFileSync(CADDYFILE, "utf8");
}
