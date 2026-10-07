import "server-only";
import { createHash } from "node:crypto";
import { all } from "./db";
import type { User } from "./auth/users";
import { listOpen } from "./findings";
import { listActivity } from "./audit";
import { appsForMember, lanHost, listApps, type AppSummary } from "./docker/apps";
import { KINDS } from "./integrations/registry";
import { contextFor, usableRecords, type IntegrationRecord } from "./integrations/store";
import type { KindSearchHit } from "./integrations/kinds/base";
import { searchNames } from "./files/search";
import { places } from "./files/places";
import type { ProviderDef, ProviderGroup, ProviderItem, SearchCtx } from "./search";
import { activityHref, statusHref } from "@/lib/settings-links";
import { matchScore, splitVerb } from "@/lib/search-match";
import type { SearchScope } from "@/lib/search-types";
import type { Places, SearchHit } from "@/lib/files-types";

/**
 * Search sources that belong to search itself rather than to one feature module: things inside
 * connected apps, files by name, problems that need someone, the activity log and a few commands.
 * Built per request because what they cover depends on who is asking.
 */

// ------------------------------------------------------------------ connected apps

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/**
 * Where the person's browser can reach the app. The integration's own address is often 127.0.0.1
 * (from Gluon's point of view), so prefer the linked app's address for where they are, else swap a
 * loopback host for the server's LAN address.
 */
export async function webBase(rec: Pick<IntegrationRecord, "baseUrl" | "appId">, apps: AppSummary[], zone: "home" | "away"): Promise<string | null> {
  const app = rec.appId ? apps.find((a) => a.id === rec.appId) : undefined;
  const linked = app ? (zone === "away" ? (app.urls.away ?? app.urls.home) : (app.urls.home ?? app.urls.away)) : null;
  if (linked && /^https?:\/\//i.test(linked)) return linked.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(rec.baseUrl);
  } catch {
    return null;
  }
  if (LOOPBACK.test(u.hostname)) {
    if (zone === "away") return null;
    u.hostname = await lanHost();
  }
  return u.toString().replace(/\/+$/, "");
}

/** Point a link the app made (against its internal address) at the address the person can open. */
export function rebase(url: string | undefined, internal: string, publicBase: string | null): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const base = internal.replace(/\/+$/, "");
  if (url.startsWith(base)) return publicBase ? publicBase + url.slice(base.length) : undefined;
  return url;
}

export function hitToItem(rec: Pick<IntegrationRecord, "id" | "baseUrl">, hit: KindSearchHit, publicBase: string | null): ProviderItem {
  const image = typeof hit.image === "string" && hit.image.startsWith(`/api/integrations/${encodeURIComponent(rec.id)}/image?`) ? hit.image : null;
  const href = rebase(hit.url, rec.baseUrl, publicBase);
  return {
    id: `int:${rec.id}:${hit.id}`,
    label: hit.label.slice(0, 200),
    hint: hit.hint?.slice(0, 200),
    icon: hit.type ?? "app",
    image,
    ...(href ? { href, external: true } : {}),
  };
}

/**
 * Kinds whose key sees one person's private library (Immich: the owner's every photo). Sharing the
 * connection for a widget doesn't make that library searchable by the household, so members never
 * search inside these.
 */
const PERSONAL_KINDS = new Set<string>(["immich"]);

/** The connected apps this person may search inside: their usable integrations whose kind can search. */
async function searchableRecords(user: User): Promise<IntegrationRecord[]> {
  const recs = usableRecords(user).filter((r) => KINDS[r.kind]?.search && (user.role === "admin" || !PERSONAL_KINDS.has(r.kind)));
  if (user.role === "admin" || !recs.some((r) => r.appId)) return recs;
  // A member only searches inside a connected app when they may open that app too.
  const mine = new Set((await appsForMember(user.id).catch(() => [])).map((a) => a.id));
  return recs.filter((r) => !r.appId || mine.has(r.appId));
}

async function appProviders(recs: IntegrationRecord[]): Promise<ProviderDef[]> {
  if (!recs.length) return [];
  const apps = recs.some((r) => r.appId) ? await listApps().catch(() => [] as AppSummary[]) : [];
  return recs.map((rec) => ({
    key: `app:${rec.id}`,
    name: rec.name,
    scope: `app:${rec.id}`,
    tier: "app" as const,
    priority: 80,
    async run(u, q, ctx) {
      const def = KINDS[rec.kind]!;
      // Who is asking: kinds that scope results by person (Home Assistant) show members less.
      const kctx = { ...contextFor(rec), viewer: { id: u.id, role: u.role } };
      const [hits, base] = await Promise.all([def.search!(kctx, q, { limit: 6, signal: ctx.signal }), webBase(rec, apps, ctx.zone)]);
      const grp: ProviderGroup = { name: rec.name, items: hits.slice(0, 8).map((h) => hitToItem(rec, h, base)) };
      if (base) grp.more = { label: `Open ${rec.name}`, href: base, external: true };
      return grp;
    },
  }));
}

// ------------------------------------------------------------------ files

type GP = typeof globalThis & { __gluonSearchPlaces?: Map<string, { at: number; value: Promise<Places> }> };
const placeCache: Map<string, { at: number; value: Promise<Places> }> = ((globalThis as GP).__gluonSearchPlaces ??= new Map());

/** The folders a person may use, cached for a minute (working them out touches Docker and every drive). */
function placesFor(user: User, grants: string): Promise<Places> {
  // Keyed by the grants fingerprint too, so a folder that stops being shared drops out at once.
  const key = `${user.id}:${user.role}:${grants}`;
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = places(user);
  placeCache.set(key, { at: Date.now(), value });
  value.catch(() => placeCache.delete(key));
  return value;
}

/** The word to hand to the name search: the longest one typed, as typed (names match accents literally). */
export function findWord(q: string): string {
  const ws = q.trim().split(/\s+/).filter(Boolean);
  return ws.sort((a, b) => b.length - a.length)[0] ?? "";
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function fileItem(h: SearchHit): ProviderItem {
  const dir = h.type === "dir";
  const parent = parentOf(h.path);
  return {
    id: `file:${h.path}`,
    label: h.name,
    hint: parent,
    icon: dir ? "folder" : `file-${h.kind}`,
    image: h.kind === "image" ? `/api/files/thumb?path=${encodeURIComponent(h.path)}&size=160` : null,
    href: dir ? `/files?path=${encodeURIComponent(h.path)}` : `/files?path=${encodeURIComponent(parent)}&select=${encodeURIComponent(h.name)}`,
  };
}

/** Pinned, well-known and recent folders whose name or path matches, as the sidebar of Files lists them. */
export function placeItems(p: Places, q: SearchCtx["query"]): ProviderItem[] {
  const out: ProviderItem[] = [];
  const seen = new Set<string>();
  const consider = (label: string, path: string, hint: string) => {
    if (seen.has(path)) return;
    const score = matchScore(q, { label, hint: path });
    if (!score) return;
    seen.add(path);
    out.push({ id: `folder:${path}`, label, hint, icon: "folder", href: `/files?path=${encodeURIComponent(path)}`, score: Math.max(score, 0.5) });
  };
  for (const pin of p.pins) if (!pin.missing) consider(pin.label, pin.path, `Pinned · ${pin.path}`);
  for (const pl of p.places) if (!pl.missing) consider(pl.label, pl.path, pl.kind === "media" && pl.apps?.length ? `Used by ${pl.apps.slice(0, 2).map((x) => x.name).join(", ")} · ${pl.path}` : pl.path);
  for (const r of p.recent) consider(r.label, r.path, `Recent · ${r.path}`);
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Names found by the deadline are shown rather than nothing when a big drive is slow to walk. */
const FILE_DEADLINE_MS = 1100;

const filesProvider: ProviderDef = {
  key: "files",
  name: "Files",
  scope: "files",
  priority: 30,
  budgetMs: 1500,
  minLength: 2,
  async run(user, q, ctx) {
    const word = findWord(q);
    const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(FILE_DEADLINE_MS)]);
    const [p, hits] = await Promise.all([
      placesFor(user, grantsKey(user)).catch(() => null),
      word.length >= 3 ? searchNames(user, null, word, { limit: 60, signal: deadline }).catch(() => [] as SearchHit[]) : Promise.resolve([] as SearchHit[]),
    ]);
    const items: ProviderItem[] = p ? placeItems(p, ctx.query).slice(0, 4) : [];
    const seen = new Set(items.map((i) => i.href));
    const scored = hits
      .map((h) => ({ h, s: matchScore(ctx.query, { label: h.name, hint: h.path }) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || Number(b.h.type === "dir") - Number(a.h.type === "dir") || a.h.path.length - b.h.path.length);
    for (const { h, s } of scored) {
      const it = fileItem(h);
      if (seen.has(it.href)) continue;
      seen.add(it.href);
      items.push({ ...it, score: s * 0.9 });
      if (items.length >= 10) break;
    }
    return { name: "Files", items };
  },
};

// ------------------------------------------------------------------ problems, activity, commands

const findingsProvider: ProviderDef = {
  key: "findings",
  name: "Needs you",
  priority: 12,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items: ProviderItem[] = [];
    // "fix var" asks for the fix: the one problem that fits gets its fix as the best match.
    const { verb, rest } = splitVerb(ctx.query, { fix: "fix", repair: "fix", solve: "fix", resolve: "fix" });
    const found = listOpen()
      .map((f) => {
        const fields = { label: f.title, keywords: `problem alert needs you broken ${f.severity === "fault" ? "fault error down" : "attention warning"} ${f.subject ?? ""}`, hint: f.cause ?? "" };
        return { f, fields, score: Math.max(matchScore(ctx.query, fields), verb ? matchScore(rest, fields) : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const unique = found.length === 1 || (found.length > 1 && found[1]!.score < found[0]!.score - 0.02);
    for (const [i, { f, fields, score }] of found.entries()) {
      const asked = !!verb && unique && i === 0;
      items.push({ id: `finding:${f.id}`, label: f.title, hint: f.cause?.slice(0, 160) ?? undefined, icon: "finding", href: statusHref(f.id), score, keywords: fields.keywords });
      const r = f.remedy;
      if (r?.action) {
        items.push({
          id: `remedy:${f.id}`,
          label: r.label,
          hint: `Fixes: ${f.title}`,
          icon: "fix",
          score: asked ? 1 : score * 0.98,
          final: asked,
          keywords: `fix ${fields.keywords}`,
          action: {
            url: "/api/remedies",
            body: { action: r.action, params: r.params ?? {}, findingId: f.id },
            pending: `${r.label}…`,
            failed: `Couldn't ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}`,
            // Fixes always ask from here: Enter in a list is too easy to press by accident.
            confirm: r.confirm
              ? { title: r.confirm.title, consequences: r.confirm.consequences, typeToConfirm: r.confirm.typeToConfirm, confirmLabel: r.label, danger: true }
              : { title: `${r.label}?`, description: f.title, confirmLabel: r.label },
          },
        });
      }
    }
    return { name: "Needs you", items: items.slice(0, 6) };
  },
};

const activityProvider: ProviderDef = {
  key: "activity",
  name: "Activity",
  priority: 95,
  minLength: 3,
  run(user, q, ctx) {
    if (user.role !== "admin") return null;
    const word = ctx.query.tokens[0] ?? q;
    const rows = listActivity({ q: word.replace(/[%_]/g, ""), limit: 60 });
    const items: ProviderItem[] = [];
    for (const r of rows) {
      const score = matchScore(ctx.query, { label: r.summary, keywords: `${r.target ?? ""} ${r.action.replace(/[._]/g, " ")}`, hint: r.username ?? "" });
      if (!score) continue;
      items.push({
        id: `activity:${r.id}`,
        label: r.summary,
        hint: r.kind === "system" ? "Gluon" : (r.username ?? "Someone"),
        icon: "history",
        at: r.at,
        href: activityHref({ target: r.target }),
        score: Math.min(score, 0.7),
      });
      if (items.length >= 5) break;
    }
    return { name: "Activity", items, more: { label: "See all activity", href: activityHref() } };
  },
};

const COMMANDS: { id: string; label: string; hint: string; keywords: string; action: ProviderItem["action"] }[] = [
  {
    id: "checks.run",
    label: "Check everything now",
    hint: "Run every health check instead of waiting for the next round",
    keywords: "check run checks now refresh rescan scan health problems status alerts everything recheck",
    action: { url: "/api/search/action", body: { id: "checks.run" }, pending: "Checking everything…", failed: "Couldn't run the checks" },
  },
];

const commandsProvider: ProviderDef = {
  key: "commands",
  name: "Actions",
  scope: "apps",
  priority: 0,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items: ProviderItem[] = [];
    for (const c of COMMANDS) {
      const score = matchScore(ctx.query, { label: c.label, keywords: c.keywords });
      if (score) items.push({ id: `cmd:${c.id}`, label: c.label, hint: c.hint, icon: "recheck", keywords: c.keywords, action: c.action, score });
    }
    return { name: "Actions", items };
  },
};

/**
 * A fingerprint of what this person may see: their role, the apps and folders shared with them, and
 * which connections are shared. Part of every cache key in search, so a revoked share or a changed
 * role is never answered from a cache. A few small indexed reads.
 */
export function grantsKey(user: User): string {
  if (user.role === "admin") return "admin";
  const parts = [
    all<{ app_id: string }>("SELECT app_id FROM app_access WHERE user_id = ? ORDER BY app_id", user.id),
    all<{ app_id: string; household: number; hidden: number }>("SELECT app_id, household, hidden FROM app_prefs WHERE household = 1 OR hidden = 1 ORDER BY app_id"),
    all<{ id: string; path: string; access: string }>("SELECT id, path, access FROM file_grants WHERE user_id = ? ORDER BY id", user.id),
    all<{ id: string; shared: number; app_id: string | null; updated_at: number }>("SELECT id, shared, app_id, updated_at FROM integrations ORDER BY id"),
  ];
  return `member:${createHash("sha1").update(JSON.stringify(parts)).digest("base64url")}`;
}

/**
 * Everything a search request needs, worked out once: whether the scope is one this person has,
 * the per-request sources, and the grants fingerprint for the caches. null when the scope isn't theirs.
 */
export async function searchSetup(user: User, scope: string): Promise<{ extra: ProviderDef[]; grants: string } | null> {
  const grants = grantsKey(user);
  const base = [filesProvider, findingsProvider, activityProvider, commandsProvider];
  if (scope === "apps") return { extra: base, grants };
  if (scope === "files") return (await hasFiles(user, grants)) ? { extra: base, grants } : null;
  const recs = await searchableRecords(user).catch(() => [] as IntegrationRecord[]);
  if (scope !== "all" && !recs.some((r) => `app:${r.id}` === scope)) return null;
  return { extra: [...base, ...(await appProviders(recs).catch(() => []))], grants };
}

async function hasFiles(user: User, grants: string): Promise<boolean> {
  const p = await placesFor(user, grants).catch(() => null);
  return !!p && (user.role === "admin" || p.places.length > 0);
}

/** Scopes offered in the palette: everything, apps, files (when they have any), and each searchable connected app. */
export async function scopesFor(user: User): Promise<SearchScope[]> {
  const out: SearchScope[] = [
    { id: "all", label: "Everything", kind: "all" },
    { id: "apps", label: "Apps", kind: "apps" },
  ];
  if (await hasFiles(user, grantsKey(user))) out.push({ id: "files", label: "Files", kind: "files" });
  for (const r of await searchableRecords(user).catch(() => [])) out.push({ id: `app:${r.id}`, label: r.name, kind: "app" });
  return out;
}

