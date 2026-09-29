import "server-only";
import os from "node:os";
import { docker } from "../docker/client";
import { safeFetch, NetError } from "../integrations/net";
import { imageError, isLocalImage, parseImage } from "@/lib/builder/names";
import type { ImageLookup } from "@/lib/builder-types";

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

/** Per-architecture tags (amd64-latest…): Docker picks the right build by itself. */
const ARCH_TAG = /^(amd64|arm64v8|arm64|arm32v[67]|armhf|armv7|i386|ppc64le|s390x|riscv64)[-_]/;
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
    if (r.status === 200) return ((JSON.parse(r.body.toString("utf8")) as { results?: { name: string }[] }).results ?? []).map((t) => t.name).filter((t) => !ARCH_TAG.test(t)).slice(0, 25);
  }
  const r = await get(`https://${host}/v2/${repository}/tags/list?n=1000`, auth, 2 * 1024 * 1024);
  if (r.status !== 200) return [];
  const all = (JSON.parse(r.body.toString("utf8")) as { tags?: string[] }).tags ?? [];
  const versionKey = (t: string) => (t.match(/\d+/g) ?? []).map((n) => n.padStart(8, "0")).join(".");
  return all
    .filter((t) => !/^sha256-|\.sig$|\.att$|\.sbom$/.test(t) && !ARCH_TAG.test(t))
    .sort((a, b) => (versionKey(b) > versionKey(a) ? 1 : versionKey(b) < versionKey(a) ? -1 : a.localeCompare(b)))
    .slice(0, 25);
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
