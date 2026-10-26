import { isLocalImage, parseImage } from "@/lib/builder/names";

/**
 * Is there a newer image for an app? Pure decisions only: which images can be checked at all, and
 * what the registry's answer means. The network side is in apps.ts.
 */

export type ImagePlan =
  | { check: true; registry: string; repository: string; tag: string; local: string[] }
  | { check: false; reason: "pinned" | "built" | "unknown_local" | "not_a_ref" };

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const sameRepo = (a: { registry: string; repository: string }, b: { registry: string; repository: string }) =>
  a.registry === b.registry && a.repository === b.repository;

/**
 * `ref` is what the container was started from (jellyfin/jellyfin:latest); `repoDigests` are the
 * image's RepoDigests on this server (jellyfin/jellyfin@sha256:…), one per registry it came from.
 */
export function planImageCheck(ref: string, repoDigests: string[], labels: Record<string, string> = {}): ImagePlan {
  const r = ref.trim();
  if (!r || r.startsWith("sha256:") || /\s/.test(r)) return { check: false, reason: "not_a_ref" };
  if (r.includes("@")) return { check: false, reason: "pinned" };
  if (isLocalImage(r) || labels["com.docker.compose.image.builder"]) return { check: false, reason: "built" };
  const p = parseImage(r);
  const local = repoDigests
    .map((d) => {
      const at = d.lastIndexOf("@");
      if (at < 0) return null;
      const digest = d.slice(at + 1);
      return DIGEST.test(digest) && sameRepo(parseImage(d.slice(0, at)), p) ? digest : null;
    })
    .filter((d): d is string => !!d);
  // Never pulled from that registry (built here, or loaded from a file): nothing to compare with.
  if (!repoDigests.length) return { check: false, reason: "built" };
  if (!local.length) return { check: false, reason: "unknown_local" };
  return { check: true, registry: p.registry, repository: p.repository, tag: p.tag ?? "latest", local };
}

/** What the registry says the tag points at now, against the digests this image is known by here. */
export function compareDigest(local: string[], remote: string | null): "same" | "newer" | "unknown" {
  if (!remote || !DIGEST.test(remote)) return "unknown";
  return local.includes(remote) ? "same" : "newer";
}

/** Bearer realm and service from a 401's WWW-Authenticate header. */
export function parseChallenge(header: string): { realm: string; service: string | null } | null {
  if (!/^Bearer\s/i.test(header.trim())) return null;
  const realm = /realm="([^"]+)"/i.exec(header)?.[1];
  if (!realm || !/^https:\/\//i.test(realm)) return null;
  return { realm, service: /service="([^"]+)"/i.exec(header)?.[1] ?? null };
}

export const registryHost = (registry: string) => (registry === "docker.io" ? "registry-1.docker.io" : registry);

/** Media types a tag can point at: multi-arch indexes first (what RepoDigests records), then single manifests. */
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
