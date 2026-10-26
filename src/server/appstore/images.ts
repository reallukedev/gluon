import "server-only";
import os from "node:os";
import { docker } from "../docker/client";
import { safeFetch, NetError } from "../integrations/net";
import { imageError, isLocalImage, parseImage } from "@/lib/builder/names";
import { hubQuery, mapHubSearch, mapHubTags, pageTags, retryAt, sortTags } from "@/lib/builder/hub";
import type { HubSearchResult, ImageLookup, TagPage } from "@/lib/builder-types";

/**
 * Looks an image up where Docker would: this server first, then its registry (Docker Hub, GHCR,
 * Quay, lscr.io… anything speaking the registry v2 API with anonymous pull tokens). Reads the
 * image's config so the form can suggest its ports, folders and variables. Registry hosts come
 * from what the person typed, so requests go through Gluon's guarded fetch with the "member"
 * policy: public internet only, never this server or the LAN.
 */

type G = typeof globalThis & { __gluonImageCache?: Map<string, { at: number; value: ImageLookup }> };
const g = globalThis as G;
const cache = (g.__gluonImageCache ??= new Map());

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386", ppc64: "ppc64le", s390x: "s390x" };

function registryHost(r: string) {
  return r === "docker.io" ? "registry-1.docker.io" : r;
}

async function get(url: string, headers: Record<string, string>, maxBytes = 1024 * 1024) {
  return safeFetch(url, { policy: "member", headers: { "User-Agent": "Gluon", ...headers }, timeoutMs: 8000, totalMs: 15_000, maxBytes, maxRedirects: 3 });
}

/** An anonymous pull token, from whatever realm the registry points to. */
async function token(host: string, repository: string): Promise<string | null> {
  const ping = await get(`https://${host}/v2/`, {});
  if (ping.status !== 401) return null;
  const auth = String(ping.headers["www-authenticate"] ?? "");
  const realm = /realm="([^"]+)"/i.exec(auth)?.[1];
  const service = /service="([^"]+)"/i.exec(auth)?.[1];
  if (!realm || !/^https:\/\//.test(realm)) return null;
  const u = new URL(realm);
  if (service) u.searchParams.set("service", service);
  u.searchParams.set("scope", `repository:${repository}:pull`);
  const r = await get(u.toString(), {});
  if (r.status !== 200) return null;
  const j = JSON.parse(r.body.toString("utf8")) as { token?: string; access_token?: string };
  return j.token ?? j.access_token ?? null;
}

function hints(cfg: { ExposedPorts?: Record<string, unknown>; Volumes?: Record<string, unknown>; Env?: string[]; User?: string } | undefined) {
  const ports = Object.keys(cfg?.ExposedPorts ?? {})
    .map((k) => {
      const [p, proto] = k.split("/");
      return { port: Number(p), proto: (proto === "udp" ? "udp" : "tcp") as "tcp" | "udp" };
    })
    .filter((p) => Number.isInteger(p.port) && p.port > 0 && p.port < 65536)
    .sort((a, b) => a.port - b.port);
  const volumes = Object.keys(cfg?.Volumes ?? {}).filter((v) => v.startsWith("/"));
  // Variables worth showing: the image's own settings, not the runtime's plumbing.
  const skip = /^(PATH|HOME|LANG|LANGUAGE|LC_ALL|TERM|HOSTNAME|SHLVL|PWD|GPG_KEY|.*_VERSION|.*_SHA256|.*_DOWNLOAD_.*|S6_.*|PYTHON.*|NODE_.*|YARN_.*|JAVA_.*|GOLANG_.*|GO.*|DEBIAN_FRONTEND|LSIO_.*|XDG_.*|VIRTUAL_ENV|PIP_.*|NVIDIA_.*|MALLOC_.*|ATTACHED_.*|LD_.*|CUDA_.*|NV_.*|DOTNET_.*|ASPNETCORE_.*|PGDATA|PG_.*|GOSU_.*|TINI_.*|UV_.*|RUST.*|CARGO.*|BUN_.*|PNPM_.*|NPM_.*|COMPOSER_.*|PHP_.*|APACHE_.*|NGINX_.*)$/;
  const env = (cfg?.Env ?? [])
    .map((e) => ({ key: e.slice(0, e.indexOf("=")), value: e.slice(e.indexOf("=") + 1) }))
    .filter((e) => e.key && !skip.test(e.key))
    .slice(0, 20);
  return { ports, volumes, env, user: cfg?.User || null };
}

export async function lookupImage(ref: string): Promise<ImageLookup> {
  const clean = ref.trim();
  const err = imageError(clean);
  const empty: ImageLookup = { ref: clean, exists: null, local: false, unknownReason: null, tags: [], ports: [], volumes: [], env: [], user: null, description: null };
  if (err) return { ...empty, exists: false, unknownReason: err };
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;

  // On this server already?
  let result: ImageLookup = { ...empty };
  try {
    const info = await docker().getImage(clean.includes(":") || clean.includes("@") ? clean : `${clean}:latest`).inspect();
    result = { ...result, exists: true, local: true, ...hints(info.Config as never) };
  } catch {
    /* not local */
  }
  if (isLocalImage(clean)) {
    if (!result.local) result = { ...result, exists: false, unknownReason: "Gluon built this image once, but it isn't on this server any more. Rebuild the app." };
    cache.set(clean, { at: Date.now(), value: result });
    return result;
  }

  const p = parseImage(clean);
  const host = registryHost(p.registry);
  const reference = p.digest ?? p.tag ?? "latest";
  try {
    const tok = await token(host, p.repository);
    const auth: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
    const man = await get(`https://${host}/v2/${p.repository}/manifests/${reference}`, { ...auth, Accept: ACCEPT });
    if (man.status === 404 || man.status === 401 || man.status === 403) {
      // Registries answer 401/403 for images that don't exist, to avoid confirming private names.
      result = { ...result, exists: result.local ? true : false, unknownReason: result.local ? null : man.status === 404 ? `There's no ${p.tag ? `tag “${reference}” of ` : ""}${p.repository.replace(/^library\//, "")} on ${p.registry}.` : `${p.registry} won't show ${p.repository.replace(/^library\//, "")}: it doesn't exist, or it's private.` };
    } else if (man.status === 200) {
      result.exists = true;
      let body = JSON.parse(man.body.toString("utf8")) as { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]; config?: { digest: string } };
      if (body.manifests) {
        const arch = ARCH[os.arch()] ?? "amd64";
        const pick = body.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
        if (!pick) {
          const archs = [...new Set(body.manifests.map((m) => m.platform?.architecture).filter((a) => a && a !== "unknown"))];
          result.unknownReason = `This image has no build for this server (${arch}); it has ${archs.join(", ") || "other platforms"}.`;
        } else {
          const sub = await get(`https://${host}/v2/${p.repository}/manifests/${pick.digest}`, { ...auth, Accept: ACCEPT });
          body = sub.status === 200 ? JSON.parse(sub.body.toString("utf8")) : {};
        }
      }
      if (body.config?.digest && !result.local) {
        const cfg = await get(`https://${host}/v2/${p.repository}/blobs/${body.config.digest}`, auth, 2 * 1024 * 1024);
        if (cfg.status === 200) Object.assign(result, hints((JSON.parse(cfg.body.toString("utf8")) as { config?: never }).config));
      }
    } else if (man.status === 429) {
      result.unknownReason = `${p.registry} is limiting requests right now, so Gluon couldn't check this image.`;
    } else {
      result.unknownReason = `${p.registry} answered ${man.status}, so Gluon couldn't check this image.`;
    }
    result.tags = await tags(host, p.registry, p.repository, auth).catch(() => []);
    if (p.registry === "docker.io") result.description = await hubDescription(p.repository).catch(() => null);
  } catch (e) {
    if (!result.local) result.unknownReason = e instanceof NetError ? `Gluon couldn't reach ${p.registry} (${e.message}), so it couldn't check this image.` : "Gluon couldn't check this image right now.";
  }
  cache.set(clean, { at: Date.now(), value: result });
  return result;
}

/** Recent tags: Docker Hub's own API sorts by date; other registries get a version sort. */
async function tags(host: string, registry: string, repository: string, auth: Record<string, string>): Promise<string[]> {
  if (registry === "docker.io") {
    const [ns, name] = repository.split("/");
    const r = await get(`https://hub.docker.com/v2/namespaces/${ns}/repositories/${name}/tags?page_size=100&ordering=last_updated`, {});
    if (r.status === 200) return mapHubTags(JSON.parse(r.body.toString("utf8")), ARCH[os.arch()] ?? "amd64").tags.map((t) => t.name).slice(0, 25);
  }
  return (await registryTags(host, repository, auth)).slice(0, 25);
}

/** A registry's whole tag list (up to 1000), sorted newest-looking first. */
async function registryTags(host: string, repository: string, auth: Record<string, string>): Promise<string[]> {
  const r = await get(`https://${host}/v2/${repository}/tags/list?n=1000`, auth, 2 * 1024 * 1024);
  if (r.status !== 200) throw new RegistryAnswer(r.status);
  return sortTags((JSON.parse(r.body.toString("utf8")) as { tags?: string[] }).tags ?? []);
}

class RegistryAnswer extends Error {
  constructor(public status: number) {
    super(`answered ${status}`);
  }
}

// ---------------------------------------------------------------- Docker Hub search and tag pages

/**
 * Docker Hub allows anonymous clients about 180 requests a minute per address, shared by
 * everything on this network. Answers are cached for 10 minutes, and after a 429 nothing is sent
 * until Docker Hub's own reset time.
 */
type Cache<T> = Map<string, { at: number; value: T }>;
type H = typeof globalThis & { __gluonHub?: { search: Cache<HubSearchResult>; tags: Cache<TagPage>; lists: Cache<string[]>; blockedUntil: number } };
type HubState = NonNullable<H["__gluonHub"]>;
const hub: HubState = ((globalThis as H).__gluonHub ??= { search: new Map(), tags: new Map(), lists: new Map(), blockedUntil: 0 } satisfies HubState);
const TTL = 10 * 60_000;

function cached<T>(c: Cache<T>, key: string): T | null {
  const hit = c.get(key);
  if (!hit || Date.now() - hit.at > TTL) return null;
  // Map order doubles as recency, so the oldest entry goes first when the cache is full.
  c.delete(key);
  c.set(key, hit);
  return hit.value;
}
function remember<T>(c: Cache<T>, key: string, value: T) {
  c.set(key, { at: Date.now(), value });
  while (c.size > 300) c.delete(c.keys().next().value!);
}

const limitedText = () => {
  const s = Math.max(1, Math.ceil((hub.blockedUntil - Date.now()) / 1000));
  return `Docker Hub is limiting requests from this network for ${s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`}. Type the full image name instead, like jellyfin/jellyfin.`;
};

export async function searchHub(input: string): Promise<HubSearchResult> {
  const q = hubQuery(input);
  if (!q) return { query: input.trim(), results: [], error: null };
  const hit = cached(hub.search, q);
  if (hit) return hit;
  if (Date.now() < hub.blockedUntil) return { query: q, results: [], error: limitedText() };
  try {
    const r = await get(`https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=12`, { Accept: "application/json" });
    if (r.status === 429) {
      hub.blockedUntil = retryAt(r.headers);
      return { query: q, results: [], error: limitedText() };
    }
    if (r.status !== 200) return { query: q, results: [], error: `Docker Hub answered ${r.status}, so search isn't working right now. Type the full image name instead.` };
    if (Number(r.headers["x-ratelimit-remaining"]) === 0) hub.blockedUntil = retryAt(r.headers);
    const value: HubSearchResult = { query: q, results: mapHubSearch(JSON.parse(r.body.toString("utf8"))), error: null };
    remember(hub.search, q, value);
    return value;
  } catch (e) {
    return { query: q, results: [], error: e instanceof NetError ? `Gluon couldn't reach Docker Hub (${e.message}). Type the full image name instead.` : "Search isn't working right now. Type the full image name instead." };
  }
}

const PAGE = 30;

/** One page of an image's tags, newest first, filtered by `q`. Works before the image is looked up. */
export async function tagPage(ref: string, q: string, page: number): Promise<TagPage> {
  const clean = ref.trim();
  const base: TagPage = { ref: clean, tags: [], page, next: false, error: null };
  const err = imageError(clean);
  if (err) return { ...base, error: err };
  if (isLocalImage(clean)) return { ...base, error: "Gluon builds this image itself, so it has no tags to choose from." };
  const p = parseImage(clean);
  const key = `${p.registry}/${p.repository}|${q.trim().toLowerCase()}|${page}`;
  const hit = cached(hub.tags, key);
  if (hit) return hit;
  try {
    let out: TagPage;
    if (p.registry === "docker.io") {
      if (Date.now() < hub.blockedUntil) return { ...base, error: limitedText() };
      const [ns, name] = p.repository.split("/");
      const u = new URL(`https://hub.docker.com/v2/namespaces/${ns}/repositories/${name}/tags`);
      u.searchParams.set("page_size", String(PAGE));
      u.searchParams.set("page", String(page));
      u.searchParams.set("ordering", "last_updated");
      if (q.trim()) u.searchParams.set("name", q.trim());
      const r = await get(u.toString(), { Accept: "application/json" });
      if (r.status === 429) {
        hub.blockedUntil = retryAt(r.headers);
        return { ...base, error: limitedText() };
      }
      if (r.status === 404) return { ...base, error: page > 1 ? null : `Docker Hub has no image called ${p.repository.replace(/^library\//, "")}.` };
      if (r.status !== 200) return { ...base, error: `Docker Hub answered ${r.status}, so the tags didn't load. Try again in a moment.` };
      const m = mapHubTags(JSON.parse(r.body.toString("utf8")), ARCH[os.arch()] ?? "amd64");
      out = { ...base, tags: m.tags, next: m.next };
    } else {
      const listKey = `${p.registry}/${p.repository}`;
      let all = cached(hub.lists, listKey);
      if (!all) {
        const host = registryHost(p.registry);
        const tok = await token(host, p.repository);
        all = await registryTags(host, p.repository, tok ? { Authorization: `Bearer ${tok}` } : {});
        remember(hub.lists, listKey, all);
      }
      const pg = pageTags(all, q, page, PAGE);
      out = { ...base, tags: pg.tags.map((name) => ({ name, updated: null, size: null })), next: pg.next };
    }
    remember(hub.tags, key, out);
    return out;
  } catch (e) {
    if (e instanceof RegistryAnswer) return { ...base, error: e.status === 401 || e.status === 403 || e.status === 404 ? `${p.registry} won't list the tags of ${p.repository}: it doesn't exist, or it's private.` : `${p.registry} answered ${e.status}, so the tags didn't load.` };
    return { ...base, error: e instanceof NetError ? `Gluon couldn't reach ${p.registry} (${e.message}). Check the server's internet connection, then try again.` : "The tags didn't load. Try again in a moment." };
  }
}

async function hubDescription(repository: string): Promise<string | null> {
  const [ns, name] = repository.split("/");
  const r = await get(`https://hub.docker.com/v2/namespaces/${ns}/repositories/${name}`, {});
  if (r.status !== 200) return null;
  const d = (JSON.parse(r.body.toString("utf8")) as { description?: string }).description;
  return d ? d.slice(0, 300) : null;
}

/** For publishing: does every image exist? Unknowns (registry down) don't block. */
export async function missingImages(refs: string[]): Promise<{ ref: string; reason: string }[]> {
  const out: { ref: string; reason: string }[] = [];
  await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      if (ref.includes("$")) return;
      const l = await lookupImage(ref);
      if (l.exists === false) out.push({ ref, reason: l.unknownReason ?? "It doesn't exist." });
    }),
  );
  return out;
}
