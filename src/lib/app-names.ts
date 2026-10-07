/**
 * Names for apps as people say them. Store and installer names carry vendor prefixes ("Big Bear
 * CasaOS User Management") and ids carry the server's name ("leech-appstore"); both are noise in
 * a tight label.
 */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const SOURCE_NAME: Record<string, string> = { gluon: "Gluon", casaos: "CasaOS", umbrel: "Umbrel", compose: "Compose", docker: "Container" };

/** Where an install came from, in words ("CasaOS"). */
export const sourceName = (source: string) => SOURCE_NAME[source] ?? source;

/**
 * A short label for an app: drops an installer's vendor prefix and the server's own name.
 * "Big Bear CasaOS User Management" → "CasaOS User Management"; "Leech Appstore" → "Appstore".
 */
export function shortName(name: string, serverName?: string | null): string {
  let n = name.trim().replace(/^big[\s-]*bear\s+/i, "");
  if (serverName) {
    const re = new RegExp(`^${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s-]+`, "i");
    const rest = n.replace(re, "");
    if (rest.trim()) n = rest;
  }
  return n || name;
}

/**
 * Two installs of the same app ("Immich" from Umbrel and from CasaOS) otherwise show as identical
 * names. For names that collide, returns what tells each one apart: where it was installed from
 * when that differs ("CasaOS"), else what its id adds ("big-bear-immich" → "Big Bear").
 */
export function instanceHints<T extends { id: string; name: string; source?: string }>(apps: T[]): Map<string, string | null> {
  const byName = new Map<string, T[]>();
  for (const a of apps) byName.set(a.name.toLowerCase(), [...(byName.get(a.name.toLowerCase()) ?? []), a]);
  const out = new Map<string, string | null>();
  for (const group of byName.values()) {
    const sources = new Set(group.map((a) => a.source ?? ""));
    for (const a of group) {
      if (group.length < 2) {
        out.set(a.id, null);
        continue;
      }
      if (a.source && sources.size === group.length) {
        out.set(a.id, sourceName(a.source));
        continue;
      }
      const rest = slug(a.id).replace(slug(a.name), "").replace(/-+/g, " ").trim();
      out.set(a.id, rest ? rest.replace(/\b\w/g, (c) => c.toUpperCase()) : null);
    }
  }
  return out;
}
