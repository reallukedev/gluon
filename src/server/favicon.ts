import "server-only";
import { safeFetch, type NetPolicy } from "./integrations/net";

/**
 * Fetch a site's icon server-side (no third-party icon service), with a small cache. Requests go
 * through the guarded fetcher: every address is checked when connecting (no DNS rebinding), each
 * redirect hop is re-checked, and members can't reach the home network or the server itself.
 */

interface Icon {
  type: string;
  body: Buffer;
  at: number;
}
const cache = new Map<string, Icon | null>();
const MAX = 300;
const TTL = 24 * 3_600_000;

async function get(url: string, accept: string, limit: number, policy: NetPolicy): Promise<{ type: string; body: Buffer; finalUrl: string } | null> {
  try {
    const r = await safeFetch(url, { policy, maxBytes: limit, timeoutMs: 4000, totalMs: 6000, maxRedirects: 3, headers: { Accept: accept, "User-Agent": "Gluon/1.0 (favicon)" } });
    if (r.status < 200 || r.status >= 300) return null;
    return { type: String(r.headers["content-type"] ?? ""), body: r.body, finalUrl: r.url };
  } catch {
    return null;
  }
}

function isImage(type: string, body: Buffer) {
  if (/^image\//.test(type)) return true;
  // .ico served as octet-stream
  return body.length > 4 && body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0;
}

export async function favicon(raw: string, policy: NetPolicy): Promise<Icon | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const key = `${policy}:${u.origin}`;
  const hit = cache.get(key);
  if (hit !== undefined && (!hit || Date.now() - hit.at < TTL)) return hit;

  let icon: Icon | null = null;
  const page = await get(u.origin + "/", "text/html", 512 * 1024, policy);
  if (page && /html/.test(page.type)) {
    const html = page.body.toString("utf8");
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const pick =
      links.find((l) => /rel=["']?[^"'>]*apple-touch-icon/i.test(l)) ??
      links.find((l) => /rel=["']?(shortcut )?icon["'\s>]/i.test(l)) ??
      links.find((l) => /rel=["']?[^"'>]*icon/i.test(l));
    const href = pick?.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) {
      const abs = new URL(href, page.finalUrl);
      if (abs.protocol === "https:" || abs.protocol === "http:") {
        const r = await get(abs.toString(), "image/*", 256 * 1024, policy);
        if (r && isImage(r.type, r.body)) icon = { type: r.type.startsWith("image/") ? r.type : "image/x-icon", body: r.body, at: Date.now() };
      }
    }
  }
  if (!icon) {
    const r = await get(u.origin + "/favicon.ico", "image/*", 256 * 1024, policy);
    if (r && isImage(r.type, r.body)) icon = { type: r.type.startsWith("image/") ? r.type : "image/x-icon", body: r.body, at: Date.now() };
  }
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, icon);
  return icon;
}
