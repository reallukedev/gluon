import "server-only";
import type { User } from "./auth/users";
import { AppError } from "./errors";
import { matchScore, prepare, type Query } from "@/lib/search-match";
import type { SearchAction, SearchEvent, SearchGroupOut, SearchItem, SearchTier } from "@/lib/search-types";

/**
 * Universal search (⌘K). Feature modules register providers; `runSearch` asks all of them at once,
 * gives each a time budget, and hands every group to `emit` the moment it is ready, so a slow app
 * never holds back the rest. Queries are never logged or written anywhere; results are cached in
 * memory for a few seconds per person.
 */

/** The older provider shape (still used by the network module). */
export interface SearchGroup {
  name: string;
  items: { id: string; label: string; hint?: string; icon?: string; href?: string; external?: boolean }[];
}

/** A result as a provider hands it over. `keywords` help matching and never leave the server. */
export interface ProviderItem extends SearchItem {
  keywords?: string;
  /**
   * The provider's `score` is the whole story: don't raise it from how the text matches. For results
   * a provider deliberately keeps out of "best match" (an ambiguous restart) or puts there (the
   * action that was asked for).
   */
  final?: boolean;
}

export interface ProviderGroup {
  key?: string;
  name: string;
  items: ProviderItem[];
  priority?: number;
  more?: SearchGroupOut["more"];
}

export interface SearchCtx {
  /** Aborted when the budget runs out or the person types something else. */
  signal: AbortSignal;
  query: Query;
  zone: "home" | "away";
  scope: string;
}

export type ProviderResult = ProviderItem[] | ProviderGroup | ProviderGroup[] | null | undefined;

export interface ProviderDef {
  key: string;
  name: string;
  /** Which scope (besides "all") runs it: "apps", "files", "app:<integration id>". Default: only "all". */
  scope?: string;
  tier?: SearchTier;
  /** Default 900 ms for local providers, 2 s for apps. */
  budgetMs?: number;
  /** Lower comes first among groups that match equally well. */
  priority?: number;
  /** Shortest query it answers (default 2). */
  minLength?: number;
  run(user: User, q: string, ctx: SearchCtx): Promise<ProviderResult> | ProviderResult;
}

type LegacyProvider = (user: User, q: string) => Promise<SearchGroup | null> | SearchGroup | null;

// On globalThis: providers register from instrumentation's module graph, but route handlers are
// bundled separately and would otherwise see an empty list.
type G = typeof globalThis & { __gluonSearchDefs?: Map<string, ProviderDef> };
const g = globalThis as G;
const defs: Map<string, ProviderDef> = (g.__gluonSearchDefs ??= new Map());

/** Group order when two groups match equally well. Names cover providers that don't say. */
const NAME_PRIORITY: Record<string, number> = {
  "Public addresses": 22,
};

/**
 * Feature modules register a provider (apps, files, disks, people…). Registering the same key again
 * (hot reload) replaces it. The older `(user, q) => group` form still works.
 */
export function registerSearch(p: ProviderDef | LegacyProvider) {
  if (typeof p === "function") {
    // Same source text means the same provider re-registered by a hot reload.
    const key = `legacy:${hash(p.toString())}`;
    defs.set(key, {
      key,
      name: "",
      run: async (user, q) => {
        const grp = await p(user, q);
        return grp ? { name: grp.name, items: grp.items, priority: NAME_PRIORITY[grp.name] } : null;
      },
    });
    return;
  }
  defs.set(p.key, p);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function registeredProviders(): ProviderDef[] {
  return [...defs.values()];
}

// ------------------------------------------------------------------ running

export const LOCAL_BUDGET_MS = 900;
export const APP_BUDGET_MS = 2000;
const MAX_PER_GROUP = 8;

export class SearchTimeout extends Error {
  constructor() {
    super("timeout");
  }
}

/** Resolve with the promise, or reject when the signal fires (the work itself may run on, unobserved). */
export function withSignal<T>(p: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SearchTimeout());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SearchTimeout());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Score, sort and trim one group. Provider order breaks ties, so an app's own relevance survives. */
export function finishGroup(def: Pick<ProviderDef, "key" | "name" | "tier" | "priority">, grp: ProviderGroup, q: Query): SearchGroupOut | null {
  const tier = def.tier ?? "local";
  const items = grp.items
    .map((it, i) => {
      const text = matchScore(q, { label: it.label, keywords: it.keywords, hint: it.hint });
      // A provider only returns what it found, so even a match our scorer can't see (a photo found
      // by what's in it, a path) stays in, ranked low.
      const floor = tier === "app" ? 0.35 : 0.3;
      const score = it.final && it.score !== undefined ? it.score : Math.max(it.score ?? 0, text, floor) * (tier === "app" ? 0.92 : 1);
      return { it: clean(it, score), i };
    })
    .sort((a, b) => (b.it.score ?? 0) - (a.it.score ?? 0) || a.i - b.i)
    .slice(0, MAX_PER_GROUP)
    .map((x) => x.it);
  if (!items.length) return null;
  return { key: grp.key ?? def.key, name: grp.name || def.name, tier, priority: grp.priority ?? def.priority ?? (tier === "app" ? 80 : 50), items, ...(grp.more ? { more: grp.more } : {}) };
}

/** Drop server-only fields and anything that could point off-site where it shouldn't. */
function clean(it: ProviderItem, score: number): SearchItem {
  const out: SearchItem = { id: it.id, label: it.label, score: Math.round(score * 1000) / 1000 };
  if (it.hint) out.hint = it.hint;
  if (it.icon) out.icon = it.icon;
  if (it.image && safeImage(it.image)) out.image = it.image;
  if (it.at) out.at = it.at;
  if (it.href && safeHref(it.href, !!it.external)) {
    out.href = it.href;
    if (it.external) out.external = true;
  }
  if (it.action && safeAction(it.action)) out.action = it.action;
  return out;
}

const safeImage = (u: string) => u.startsWith("/api/") || /^data:image\/(png|jpeg|webp|gif|svg\+xml);/.test(u) || /^https:\/\//.test(u);
function safeHref(h: string, external: boolean): boolean {
  if (h.startsWith("/") && !h.startsWith("//")) return true;
  return external && /^https?:\/\//i.test(h);
}
const safeAction = (a: SearchAction) => a.url.startsWith("/api/") && !a.url.includes("..");

function normalise(res: ProviderResult, def: ProviderDef): ProviderGroup[] {
  if (!res) return [];
  if (Array.isArray(res)) {
    if (!res.length) return [];
    return "items" in (res[0] as object) ? (res as ProviderGroup[]) : [{ name: def.name, items: res as ProviderItem[] }];
  }
  return [res];
}

/** What a failure says to the person. Timeouts name the app; members never see technical detail. */
function failMessage(def: ProviderDef, e: unknown, user: User, timedOut: boolean): string {
  const tier = def.tier ?? "local";
  if (timedOut) return tier === "app" ? `${def.name} didn't answer in time.` : `${def.name} took too long.`;
  if (user.role === "admin" && e instanceof AppError && e.message) return e.message;
  return tier === "app" ? `${def.name} couldn't search just now.` : `${def.name} couldn't be searched just now.`;
}

export interface RunOptions {
  scope: string;
  zone: "home" | "away";
  signal: AbortSignal;
  emit: (e: SearchEvent) => void;
  /** Extra providers for this request (connected apps, files), on top of the registered ones. */
  extra?: ProviderDef[];
  /**
   * Changes whenever what this person may see changes (apps, shared folders, connections, role), so
   * a revoked share is never answered from the cache. See `grantsKey` in search-sources.
   */
  grants?: string;
  /** For tests: skip the per-person cache. */
  noCache?: boolean;
}

/**
 * One person's answer to one query, per provider, each stamped with when that provider actually
 * answered. A replay keeps the original stamp, so repeating a query can't keep old results alive;
 * providers that failed or timed out aren't kept at all and are asked again.
 */
interface CacheEntry {
  groups: Map<string, { at: number; groups: SearchGroupOut[] }>;
}
type GC = typeof globalThis & { __gluonSearchCache?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = ((globalThis as GC).__gluonSearchCache ??= new Map());
const CACHE_MS = 20_000;
const CACHE_MAX = 300;

export function clearSearchCache() {
  cache.clear();
}

/** "all" runs everything, connected apps included; a scope runs only the providers that name it. */
function runs(def: ProviderDef, scope: string): boolean {
  return scope === "all" || def.scope === scope;
}

/**
 * Run every provider that applies to `scope` in parallel and emit groups as they finish:
 * start → group/fail (any order) → done. Resolves when all have answered or run out of time.
 */
export async function runSearch(user: User, q: string, o: RunOptions): Promise<void> {
  const started = Date.now();
  const term = q.trim();
  const query = prepare(term);
  if (!query.folded) {
    o.emit({ type: "done", ms: 0 });
    return;
  }
  const all = [...registeredProviders(), ...(o.extra ?? [])].filter((d) => runs(d, o.scope) && term.length >= (d.minLength ?? 2));
  const cacheKey = `${user.id}\n${user.role}\n${o.grants ?? ""}\n${o.zone}\n${o.scope}\n${query.folded}`;
  const hit = o.noCache ? undefined : cache.get(cacheKey);
  const now = Date.now();
  const entry: CacheEntry = { groups: new Map() };
  const replay = new Map<string, { at: number; groups: SearchGroupOut[] }>();
  for (const d of all) {
    const c = hit?.groups.get(d.key);
    if (c && now - c.at < CACHE_MS) replay.set(d.key, c);
  }

  const todo = all.filter((d) => !replay.has(d.key));
  o.emit({ type: "start", pending: todo.filter((d) => d.tier === "app").map((d) => ({ key: d.key, name: d.name, tier: "app" as const })) });
  for (const [key, c] of replay) {
    entry.groups.set(key, c);
    for (const grp of c.groups) o.emit({ type: "group", group: grp });
  }

  await Promise.all(
    todo.map(async (def) => {
      const budget = def.budgetMs ?? (def.tier === "app" ? APP_BUDGET_MS : LOCAL_BUDGET_MS);
      const signal = AbortSignal.any([o.signal, AbortSignal.timeout(budget)]);
      try {
        const res = await withSignal(def.run(user, term, { signal, query, zone: o.zone, scope: o.scope }), signal);
        if (o.signal.aborted) return;
        const groups = normalise(res, def)
          .map((grp) => finishGroup(def, { ...grp, key: grp.key ?? def.key }, query))
          .filter((x): x is SearchGroupOut => !!x);
        entry.groups.set(def.key, { at: Date.now(), groups });
        for (const grp of groups) o.emit({ type: "group", group: grp });
      } catch (e) {
        if (o.signal.aborted) return;
        const timedOut = e instanceof SearchTimeout || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
        if (!timedOut && !isQuiet(e)) console.error(`[gluon] search provider ${def.key} failed`, e instanceof Error ? e.message : e);
        // Local providers fail quietly unless they're the only thing being searched.
        if (def.tier === "app" || o.scope !== "all") {
          o.emit({ type: "fail", key: def.key, name: def.name || "Search", tier: def.tier ?? "local", message: failMessage(def, e, user, timedOut), timedOut });
        }
      }
    }),
  );
  if (o.signal.aborted) return;
  if (!o.noCache && entry.groups.size) {
    cache.delete(cacheKey);
    cache.set(cacheKey, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  o.emit({ type: "done", ms: Date.now() - started });
}

/** Explained failures (an app said no, a folder vanished) are shown in the result; don't fill the log. */
const isQuiet = (e: unknown) => e instanceof AppError;

/** Everything at once, for callers that can't read a stream (GET /api/search). */
export async function searchAll(user: User, q: string, o: { scope?: string; zone?: "home" | "away"; extra?: ProviderDef[]; grants?: string; signal?: AbortSignal } = {}): Promise<{ groups: SearchGroupOut[] }> {
  const groups: SearchGroupOut[] = [];
  await runSearch(user, q, {
    scope: o.scope ?? "all",
    zone: o.zone ?? "home",
    signal: o.signal ?? new AbortController().signal,
    extra: o.extra,
    grants: o.grants,
    emit: (e) => {
      if (e.type === "group") groups.push(e.group);
    },
  });
  return { groups };
}
