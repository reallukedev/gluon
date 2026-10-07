import "server-only";
import http from "node:http";
import https from "node:https";
import { one, run, now } from "../db";

/**
 * "Does this app have a login of its own?": a heuristic look at the backend's home page.
 * 401/WWW-Authenticate, a redirect to /login, a password field, or a recognised app that always asks
 * for a login → "login". A plain page that opened without any of that → "none". Anything else
 * (APIs, apps that build their page in the browser, errors) → "unknown".
 *
 * Results are stored in `login_probes` (see integration request) and fall back to memory.
 */

export interface LoginProbe {
  result: "login" | "none" | "unknown";
  evidence: string;
  fingerprint: string | null;
  admin: boolean;
  checkedAt: number;
}

interface Fingerprint {
  re: RegExp;
  name: string;
  /** true = always has a login; null = login is optional/off by default. */
  login: boolean | null;
  admin: boolean;
}

const FINGERPRINTS: Fingerprint[] = [
  { re: /\bjellyfin\b/i, name: "Jellyfin", login: true, admin: false },
  { re: /\bemby\b/i, name: "Emby", login: true, admin: false },
  { re: /\bplex\b/i, name: "Plex", login: true, admin: false },
  { re: /\bimmich\b/i, name: "Immich", login: true, admin: false },
  { re: /\bhomebridge\b/i, name: "Homebridge", login: true, admin: true },
  { re: /\bnavidrome\b/i, name: "Navidrome", login: true, admin: false },
  { re: /\bcasaos\b/i, name: "CasaOS", login: true, admin: true },
  { re: /\bumbrel\b/i, name: "Umbrel", login: true, admin: true },
  { re: /\bnextcloud\b/i, name: "Nextcloud", login: true, admin: false },
  { re: /home[- ]assistant/i, name: "Home Assistant", login: true, admin: true },
  { re: /\bportainer\b/i, name: "Portainer", login: true, admin: true },
  { re: /\bgrafana\b/i, name: "Grafana", login: true, admin: false },
  { re: /\bsyncthing\b/i, name: "Syncthing", login: null, admin: true },
  { re: /\bqbittorrent\b/i, name: "qBittorrent", login: true, admin: false },
  { re: /\btransmission\b/i, name: "Transmission", login: null, admin: false },
  { re: /pi-?hole/i, name: "Pi-hole", login: true, admin: true },
  { re: /\badguard\b/i, name: "AdGuard Home", login: true, admin: true },
  { re: /vaultwarden|bitwarden/i, name: "Vaultwarden", login: true, admin: false },
  { re: /\b(gitea|forgejo)\b/i, name: "Gitea", login: true, admin: false },
  { re: /\bpaperless\b/i, name: "Paperless", login: true, admin: false },
  { re: /\baudiobookshelf\b/i, name: "Audiobookshelf", login: true, admin: false },
  { re: /\b(overseerr|jellyseerr)\b/i, name: "Overseerr", login: true, admin: false },
  { re: /\b(sonarr|radarr|prowlarr|lidarr|readarr|bazarr)\b/i, name: "*arr", login: null, admin: true },
  { re: /\bslskd\b/i, name: "slskd", login: true, admin: false },
  { re: /\bcockpit\b/i, name: "Cockpit", login: true, admin: true },
  { re: /\bwebmin\b/i, name: "Webmin", login: true, admin: true },
  { re: /\b(phpmyadmin|adminer|pgadmin)\b/i, name: "Database admin", login: true, admin: true },
  { re: /\bdozzle\b/i, name: "Dozzle", login: null, admin: true },
  { re: /<title>\s*gluon\b/i, name: "Gluon", login: true, admin: true },
];

const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|sso|oauth2?|authorize|account\/login|session\/new|users\/sign_in)(\b|\/|\?|$)/i;

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  location: string | null;
  url: string;
}

function fetchOnce(url: URL, timeoutMs: number): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "Gluon-exposure-check/1", Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Connection: "close" },
        timeout: timeoutMs,
        rejectUnauthorized: false,
        agent: false,
      } as https.RequestOptions,
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 64 * 1024) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, location: (res.headers.location as string | undefined) ?? null, url: url.toString() });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

function fingerprint(f: Fetched): Fingerprint | null {
  const title = f.body.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[0] ?? "";
  const hay = [title, f.body.slice(0, 16_384), String(f.headers["server"] ?? ""), String(f.headers["x-powered-by"] ?? ""), String(f.headers["www-authenticate"] ?? "")].join("\n");
  return FINGERPRINTS.find((fp) => fp.re.test(hay)) ?? null;
}

function judge(f: Fetched): Omit<LoginProbe, "checkedAt"> {
  const fp = fingerprint(f);
  const admin = fp?.admin ?? false;
  const name = fp?.name ?? null;
  if (f.status === 401 || f.headers["www-authenticate"]) return { result: "login", evidence: `It asks for a password (HTTP ${f.status}).`, fingerprint: name, admin };
  if (f.status === 403) return { result: "login", evidence: "It refuses access without signing in (HTTP 403).", fingerprint: name, admin };
  if (f.location && LOGIN_PATH.test(f.location)) return { result: "login", evidence: `It sends visitors to a sign-in page (${f.location.slice(0, 80)}).`, fingerprint: name, admin };
  if (/<input[^>]+type\s*=\s*["']?password/i.test(f.body)) return { result: "login", evidence: "Its page has a password field.", fingerprint: name, admin };
  if (fp?.login === true) return { result: "login", evidence: `Looks like ${fp.name}, which always asks for a login.`, fingerprint: name, admin };
  const title = f.body.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1]?.trim() ?? "";
  if (/\b(log ?in|sign ?in|password|authenticat)/i.test(title)) return { result: "login", evidence: `Its page is titled “${title.slice(0, 60)}”.`, fingerprint: name, admin };
  if (fp?.login === null) return { result: "unknown", evidence: `Looks like ${fp.name}, where the login is optional. Check its settings.`, fingerprint: name, admin };
  const type = String(f.headers["content-type"] ?? "");
  if (f.status >= 200 && f.status < 300 && /html/i.test(type)) {
    const scripted = f.body.length < 6000 && /<script[^>]+src=/i.test(f.body) && /<div[^>]+id=["']?(root|app|__next|svelte)/i.test(f.body);
    if (scripted) return { result: "unknown", evidence: "Its page is built in the browser, so Gluon can't see whether it asks for a login.", fingerprint: name, admin };
    return { result: "none", evidence: "Its home page opened without asking for a login.", fingerprint: name, admin };
  }
  if (f.status >= 200 && f.status < 300 && /json/i.test(type)) return { result: "unknown", evidence: "It answers like an API; Gluon can't tell whether it checks credentials.", fingerprint: name, admin };
  return { result: "unknown", evidence: `Its home page answered HTTP ${f.status}.`, fingerprint: name, admin };
}

/** Look at http(s)://host:port/ (following up to 3 redirects on the same host). */
export async function probeLogin(host: string, port: number, tlsFirst = false): Promise<Omit<LoginProbe, "checkedAt">> {
  const schemes = tlsFirst ? ["https:", "http:"] : ["http:", "https:"];
  let lastErr = "";
  for (const scheme of schemes) {
    try {
      let url = new URL(`${scheme}//${host.includes(":") ? `[${host}]` : host}:${port}/`);
      let f = await fetchOnce(url, 3500);
      for (let hop = 0; hop < 3 && f.status >= 300 && f.status < 400 && f.location; hop++) {
        if (LOGIN_PATH.test(f.location)) break;
        const next = new URL(f.location, url);
        if (next.host !== url.host && next.hostname !== url.hostname) break; // leaves the backend; judge what we have
        url = next;
        f = await fetchOnce(url, 3500);
      }
      return judge(f);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      lastErr = code || (e as Error).message;
      if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EHOSTUNREACH") break;
      // HPE_* parse errors / resets usually mean "speaks TLS" or "isn't HTTP": try the other scheme.
    }
  }
  const why = lastErr === "ECONNREFUSED" ? "Nothing is listening there." : lastErr === "ETIMEDOUT" ? "It didn't answer in time." : "It doesn't look like a web page.";
  return { result: "unknown", evidence: why, fingerprint: null, admin: false };
}

// ---------------------------------------------------------------- storage

const mem = new Map<string, LoginProbe>();
let tableOk: boolean | null = null;

function hasTable(): boolean {
  if (tableOk !== null) return tableOk;
  try {
    tableOk = !!one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_probes'");
  } catch {
    tableOk = false;
  }
  return tableOk;
}

export function storedProbe(target: string): LoginProbe | null {
  if (hasTable()) {
    const r = one<{ result: LoginProbe["result"]; evidence: string | null; fingerprint: string | null; admin: number; checked_at: number }>(
      "SELECT result, evidence, fingerprint, admin, checked_at FROM login_probes WHERE target = ?",
      target,
    );
    if (r) return { result: r.result, evidence: r.evidence ?? "", fingerprint: r.fingerprint, admin: !!r.admin, checkedAt: r.checked_at };
  }
  return mem.get(target) ?? null;
}

function store(target: string, p: LoginProbe) {
  mem.set(target, p);
  if (!hasTable()) return;
  try {
    run(
      `INSERT INTO login_probes (target, result, evidence, fingerprint, admin, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET result = excluded.result, evidence = excluded.evidence, fingerprint = excluded.fingerprint,
         admin = excluded.admin, checked_at = excluded.checked_at`,
      target,
      p.result,
      p.evidence,
      p.fingerprint,
      p.admin ? 1 : 0,
      p.checkedAt,
    );
  } catch {
    /* memory copy is enough */
  }
}

const inflight = new Map<string, Promise<LoginProbe>>();

/** Cached probe (6 h), refreshed when `force` or stale. `target` is "host:port". */
export function loginProbe(host: string, port: number, opts: { force?: boolean; tls?: boolean; maxAgeMs?: number } = {}): Promise<LoginProbe> {
  const target = `${host}:${port}`;
  const cached = storedProbe(target);
  const maxAge = opts.maxAgeMs ?? 6 * 3_600_000;
  if (!opts.force && cached && now() - cached.checkedAt < maxAge) return Promise.resolve(cached);
  const running = inflight.get(target);
  if (running) return running;
  const p = probeLogin(host, port, opts.tls)
    .then((r) => {
      const full = { ...r, checkedAt: now() };
      store(target, full);
      return full;
    })
    .finally(() => inflight.delete(target));
  inflight.set(target, p);
  return p;
}
