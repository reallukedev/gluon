/**
 * Docker Hub and registry answers, mapped to what the image picker shows. Pure, so the shapes
 * Docker Hub sends can be tested without asking it.
 */
import type { HubRepo, TagInfo } from "@/lib/builder-types";

/** Per-architecture tags (amd64-latest…): Docker picks the right build by itself, so they're noise. */
export const ARCH_TAG = /^(amd64|arm64v8|arm64|arm32v[67]|armhf|armv7|i386|ppc64le|s390x|riscv64)[-_]/;
/** Signatures and attestations some registries list as tags. */
const META_TAG = /^sha256-|\.sig$|\.att$|\.sbom$/;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A search box value worth sending to Docker Hub, or null. */
export function hubQuery(input: string): string | null {
  const q = input.trim().toLowerCase();
  // A tag, digest or another registry means the person already knows the exact image.
  if (q.length < 2 || q.length > 100 || /[:@\s]/.test(q)) return null;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//.test(q) || q.startsWith("localhost/")) return null;
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(q)) return null;
  return q;
}

/** Docker Hub's /v2/search/repositories answer → repositories. */
export function mapHubSearch(json: unknown): HubRepo[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: HubRepo[] = [];
  const seen = new Set<string>();
  for (const r of results as Record<string, unknown>[]) {
    let ref = str(r.repo_name).trim();
    if (!ref) continue;
    // Official images are listed as "library/nginx" in some answers and "nginx" in others.
    if (ref.startsWith("library/")) ref = ref.slice(8);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, description: str(r.short_description).trim().replace(/\s+/g, " ").slice(0, 200), stars: num(r.star_count), pulls: num(r.pull_count), official: r.is_official === true || !ref.includes("/") });
  }
  return out;
}

/** Docker Hub's /v2/namespaces/…/tags page → tags, and whether there's another page. */
export function mapHubTags(json: unknown, arch = "amd64"): { tags: TagInfo[]; next: boolean } {
  const j = json as { results?: unknown; next?: unknown };
  const results = Array.isArray(j?.results) ? (j.results as Record<string, unknown>[]) : [];
  const tags: TagInfo[] = [];
  for (const t of results) {
    const name = str(t.name);
    if (!name || ARCH_TAG.test(name) || META_TAG.test(name)) continue;
    const when = Date.parse(str(t.tag_last_pushed) || str(t.last_updated));
    const images = Array.isArray(t.images) ? (t.images as Record<string, unknown>[]) : [];
    const mine = images.find((i) => i.os === "linux" && i.architecture === arch) ?? (images.length === 1 ? images[0] : undefined);
    tags.push({ name, updated: Number.isFinite(when) ? when : null, size: mine ? num(mine.size) || null : num(t.full_size) || null });
  }
  return { tags, next: typeof j?.next === "string" && j.next.length > 0 };
}

/** Sort a registry's tag list newest-looking first: by the numbers in them, then by name. */
export function sortTags(all: string[]): string[] {
  const key = (t: string) => (t.match(/\d+/g) ?? []).map((n) => n.padStart(10, "0")).join(".");
  return all
    .filter((t) => !META_TAG.test(t) && !ARCH_TAG.test(t))
    .sort((a, b) => {
      // latest and stable first, then versions newest first, then other words (develop, nightly).
      const rank = (t: string) => (t === "latest" ? 0 : t === "stable" ? 1 : /\d/.test(t) ? 2 : 3);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ka = key(a);
      const kb = key(b);
      return kb > ka ? 1 : kb < ka ? -1 : a.localeCompare(b);
    });
}

/** One page of a sorted tag list, filtered by what the person typed. */
export function pageTags(sorted: string[], q: string, page: number, size: number): { tags: string[]; next: boolean } {
  const f = q.trim().toLowerCase();
  const list = f ? sorted.filter((t) => t.toLowerCase().includes(f)) : sorted;
  const start = (page - 1) * size;
  return { tags: list.slice(start, start + size), next: list.length > start + size };
}

/** 429 Retry-After or Docker Hub's x-ratelimit-reset (unix seconds) → when to ask again, ms. */
export function retryAt(headers: Record<string, string | string[] | undefined>, now = Date.now()): number {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const after = Number(h("retry-after"));
  if (Number.isFinite(after) && after > 0) return now + Math.min(after, 3600) * 1000;
  const reset = Number(h("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset * 1000 > now) return Math.min(reset * 1000, now + 3600_000);
  return now + 60_000;
}
