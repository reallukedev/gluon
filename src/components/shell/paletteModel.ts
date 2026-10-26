import { matchScore, placeQuery, type Query } from "@/lib/search-match";
import type { SearchEvent, SearchGroupOut, SearchItem, SearchTier } from "@/lib/search-types";

/**
 * The palette's data model, kept free of React so it can be tested: the streamed search state, and
 * how it and the palette's own entries (pages, settings, quick actions) become the sections shown.
 */

export interface PaletteItem extends SearchItem {
  keywords?: string;
  /** Runs in the browser (switch theme, sign out). */
  run?: () => void | Promise<void>;
  /** A recent search: picking it types this into the box. */
  fill?: string;
}

/** Entries the palette knows itself, without asking the server. */
export interface StaticGroup {
  key: string;
  name: string;
  priority: number;
  items: PaletteItem[];
  /** Shown before anything is typed. */
  idle?: boolean;
}

export interface StreamGroup extends SearchGroupOut {
  /** From the previous query, still shown until this query's answer replaces it. */
  stale?: boolean;
}

export interface StreamState {
  term: string;
  scope: string;
  groups: StreamGroup[];
  /** Connected apps still being asked. */
  pending: { key: string; name: string }[];
  failed: { key: string; name: string; message: string; timedOut: boolean }[];
  /** App groups in the order they were announced, so they keep their place as answers arrive. */
  order: string[];
  done: boolean;
  /** The search itself failed (offline, rate limited). */
  error: string | null;
}

export function beginStream(prev: StreamState | null, term: string, scope: string): StreamState {
  // Keep what's on screen (marked stale) until the new answers arrive, so typing doesn't flash.
  const groups = prev && prev.scope === scope ? prev.groups.map((g) => ({ ...g, stale: true })) : [];
  return { term, scope, groups, pending: [], failed: [], order: prev && prev.scope === scope ? prev.order : [], done: false, error: null };
}

export function reduceStream(s: StreamState, e: SearchEvent): StreamState {
  switch (e.type) {
    case "start": {
      const order = [...e.pending.map((p) => p.key), ...s.order.filter((k) => !e.pending.some((p) => p.key === k))];
      return { ...s, pending: e.pending.map(({ key, name }) => ({ key, name })), order };
    }
    case "group": {
      const g: StreamGroup = e.group;
      const i = s.groups.findIndex((x) => x.key === g.key);
      // Replace a stale copy in place, so the group keeps its position.
      const groups = i < 0 ? [...s.groups, g] : s.groups.map((x, j) => (j === i ? g : x));
      const order = s.order.includes(g.key) ? s.order : [...s.order, g.key];
      return { ...s, groups, order, pending: s.pending.filter((p) => p.key !== g.key) };
    }
    case "fail":
      return {
        ...s,
        groups: s.groups.filter((x) => x.key !== e.key),
        pending: s.pending.filter((p) => p.key !== e.key),
        failed: [...s.failed.filter((f) => f.key !== e.key), { key: e.key, name: e.name, message: e.message, timedOut: e.timedOut }],
      };
    case "done":
      return { ...s, done: true, pending: [], groups: s.groups.filter((g) => !g.stale) };
  }
}

// ------------------------------------------------------------------ sections

export interface Section {
  key: string;
  name: string;
  tier: SearchTier;
  items: PaletteItem[];
  /** A connected app that hasn't answered yet. */
  loading?: boolean;
  /** Why this source has nothing to show ("Immich didn't answer in time."). */
  error?: string;
  /** The best match across everything, lifted to the top. */
  best?: boolean;
}

const BEST_MIN = 0.75;
const STRONG = 0.75;

/** "go to notifications" and "settings sidebar" score the place by its name. */
function scoreStatic(q: Query, place: Query | null, it: PaletteItem): number {
  const f = { label: it.label, keywords: it.keywords, hint: it.hint };
  return Math.max(matchScore(q, f), place ? matchScore(place, f) : 0);
}

export interface BuildOptions {
  query: Query;
  scope: string;
  statics: StaticGroup[];
  stream: StreamState | null;
  recent: string[];
  /** Results per group: fewer when searching everywhere, more inside one place. */
  perGroup: number;
}

/** The last entry under recent searches; a result so it can be reached from the keyboard. */
export const CLEAR_RECENT = "recent:clear";

/** Recent searches, quick actions and places to go, for an empty box. */
function idleSections(o: BuildOptions): Section[] {
  const out: Section[] = [];
  if (o.recent.length) {
    const items: PaletteItem[] = o.recent.map((r) => ({ id: `recent:${r}`, label: r, icon: "recent", fill: r }));
    items.push({ id: CLEAR_RECENT, label: "Clear recent searches", hint: "Only in this browser", icon: "erase" });
    out.push({ key: "recent", name: "Recent searches", tier: "local", items });
  }
  for (const g of o.statics) if (g.idle && g.items.length) out.push({ key: g.key, name: g.name, tier: "local", items: g.items });
  return out;
}

/**
 * Everything that matches, grouped: "Best match" first, then the palette's and the server's groups
 * (strong matches before weak ones, each kind in a fixed order), then connected apps in the order
 * they were asked, with loading and failed apps holding their place.
 */
export function buildSections(o: BuildOptions): Section[] {
  if (!o.query.folded) return idleSections(o);
  const min = o.query.compact.length >= 3 ? 0.3 : 0.5;
  const local: (Section & { priority: number; top: number })[] = [];

  const add = (key: string, name: string, priority: number, items: PaletteItem[]) => {
    if (!items.length) return;
    // Groups with the same name ("Actions" from the palette, the server and an app) become one.
    const same = local.find((x) => x.name === name);
    if (same) {
      same.items.push(...items);
      same.priority = Math.min(same.priority, priority);
      return;
    }
    local.push({ key, name, tier: "local", items: [...items], priority, top: 0 });
  };

  if (o.scope === "all") {
    const place = placeQuery(o.query);
    for (const g of o.statics) {
      const items = g.items
        .map((it) => ({ ...it, score: scoreStatic(o.query, place, it) }))
        .filter((it) => (it.score ?? 0) >= min);
      add(g.key, g.name, g.priority, items);
    }
  }

  const apps: Section[] = [];
  const stream = o.stream;
  const appGroups = new Map<string, StreamGroup>();
  for (const g of stream?.groups ?? []) {
    if (g.tier === "app") {
      appGroups.set(g.key, g);
      continue;
    }
    // A stale group still on screen keeps only what matches what's typed now.
    const items = g.stale ? g.items.map((it) => ({ ...it, score: Math.max(matchScore(o.query, { label: it.label, hint: it.hint }), 0) })).filter((it) => (it.score ?? 0) > 0) : g.items;
    add(g.key, g.name, g.priority, items);
  }

  if (stream) {
    const keys = [...stream.order];
    for (const k of appGroups.keys()) if (!keys.includes(k)) keys.push(k);
    for (const key of keys) {
      const g = appGroups.get(key);
      const pending = stream.pending.find((p) => p.key === key);
      const failed = stream.failed.find((f) => f.key === key);
      if (g) apps.push({ key, name: g.name, tier: "app", items: [...g.items], loading: !!pending || (g.stale && !stream.done) });
      else if (pending) apps.push({ key, name: pending.name, tier: "app", items: [], loading: true });
      else if (failed) apps.push({ key, name: failed.name, tier: "app", items: [], error: failed.message });
    }
    for (const f of stream.failed) {
      if (keys.includes(f.key) || local.some((l) => l.key === f.key)) continue;
      local.push({ key: f.key, name: f.name, tier: "local", items: [], error: f.message, priority: 99, top: 0 });
    }
  }

  // Order inside groups, then find the best match before trimming.
  for (const s of [...local, ...apps]) s.items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const s of local) s.top = s.items[0]?.score ?? 0;

  let best: PaletteItem | null = null;
  for (const s of [...local, ...apps]) for (const it of s.items) if ((it.score ?? 0) >= BEST_MIN && (!best || (it.score ?? 0) > (best.score ?? 0))) best = it;

  local.sort((a, b) => Number(b.top >= STRONG) - Number(a.top >= STRONG) || a.priority - b.priority);
  const sections: Section[] = [];
  if (best) sections.push({ key: "best", name: "Best match", tier: "local", items: [best], best: true });
  sections.push(...local.map(({ priority: _p, top: _t, ...s }) => s), ...apps);

  // Each thing once (the first place it appears), then trim.
  const seenId = new Set<string>();
  const seenHref = new Set<string>();
  for (const s of sections) {
    s.items = s.items.filter((it) => {
      if (seenId.has(it.id) || (it.href && !it.action && seenHref.has(it.href))) return false;
      seenId.add(it.id);
      if (it.href && !it.action) seenHref.add(it.href);
      return true;
    });
    if (!s.best) s.items = s.items.slice(0, o.perGroup);
  }
  return sections.filter((s) => s.items.length || s.loading || s.error);
}

export const flatten = (sections: Section[]): PaletteItem[] => sections.flatMap((s) => s.items);

/** What the live region says once results settle: "12 results. Immich didn't answer in time." */
export function announce(sections: Section[], stream: StreamState | null, term: string): string {
  if (!term) return "";
  if (stream?.error) return stream.error;
  const settled = !stream || stream.done || term.length < 2;
  if (!settled) return "";
  const n = flatten(sections).length;
  const fails = sections.filter((s) => s.error).map((s) => s.error);
  return [n ? `${n} result${n === 1 ? "" : "s"}.` : "No results.", ...fails].join(" ");
}
