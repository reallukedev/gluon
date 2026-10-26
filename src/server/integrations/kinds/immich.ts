import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { matchScore, prepare } from "@/lib/search-match";
import { imageUrl } from "../image-refs";
import type { ImmichMemory, ImmichOnThisDayData, ImmichRecentData, ImmichStatsData } from "@/lib/widgets-types";

const schema = z.object({
  apiKey: z.string().trim().min(20, "Paste the whole API key from Immich.").max(200),
  allowSelfSigned: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function http(ctx: KindContext<Config>) {
  return client(def, ctx, (status) =>
    status === 401
      ? "Immich answered 401: the API key is wrong (or was deleted)."
      : "Immich answered 403: this API key is missing a permission Gluon needs.",
  );
}

function thumb(ctx: KindContext<Config>, assetId: string, size: "thumbnail" | "preview" = "thumbnail"): string | null {
  if (!UUID.test(assetId)) return null;
  return imageUrl(ctx.id, assetId.toLowerCase(), { asset: assetId.toLowerCase(), size });
}

interface RawMemory {
  id: string;
  year: number | null;
  yearsAgo: number | null;
  assets: Record<string, unknown>[];
}

/** Immich's "on this day" memories for today: /api/memories (1.113+), else the older memory lane. */
async function rawMemories(ctx: KindContext<Config>): Promise<{ list: RawMemory[] | null; note: string | null }> {
  const h = http(ctx);
  const res = await h.json<unknown>("/api/memories", { query: { for: new Date().toISOString() }, allow: [403, 404] });
  const status = num(obj(res).__status);
  if (status === 403) return { list: null, note: "This API key can't read memories (it needs the memory.read permission)." };
  if (status === 404) {
    const d = new Date();
    const lane = await h.json<unknown>("/api/assets/memory-lane", { query: { day: d.getDate(), month: d.getMonth() + 1 }, allow: [403, 404] });
    if (num(obj(lane).__status)) return { list: null, note: "This version of Immich doesn't offer memories to other apps." };
    return { list: arr<Record<string, unknown>>(lane).map((m, i) => ({ id: `lane-${i}`, year: null, yearsAgo: num(m.yearsAgo), assets: arr(m.assets) })), note: null };
  }
  return {
    list: arr<Record<string, unknown>>(res)
      .filter((m) => m.type === undefined || m.type === "on_this_day")
      .map((m) => ({ id: String(m.id ?? ""), year: num(obj(m.data).year), yearsAgo: null, assets: arr(m.assets) })),
    note: null,
  };
}

const visible = (a: Record<string, unknown>) => typeof a.id === "string" && !a.isTrashed && a.visibility !== "hidden" && a.visibility !== "locked" && !a.isArchived;

async function memories(ctx: KindContext<Config>): Promise<{ list: ImmichMemory[] | null; note: string | null }> {
  const nowYear = new Date().getFullYear();
  const title = (year: number | null, yearsAgo?: number | null) => {
    const n = yearsAgo ?? (year !== null ? nowYear - year : null);
    return n === null ? "On this day" : n === 1 ? "1 year ago" : `${n} years ago`;
  };
  const raw = await rawMemories(ctx);
  if (!raw.list) return { list: null, note: raw.note };
  const list: ImmichMemory[] = raw.list
    .map((m) => ({
      id: m.id,
      title: title(m.year, m.yearsAgo),
      year: m.year ?? (m.yearsAgo !== null ? nowYear - m.yearsAgo : null),
      assets: m.assets
        .filter(visible)
        .slice(0, 8)
        .map((a) => ({ id: String(a.id), kind: a.type === "VIDEO" ? ("video" as const) : ("image" as const), image: thumb(ctx, String(a.id)) }))
        .filter((a): a is { id: string; kind: "image" | "video"; image: string } => !!a.image),
    }))
    .filter((m) => m.assets.length)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, 6);
  return { list, note: null };
}

/** One entry per earlier year with photos from today's date, each with larger (preview) images. */
async function onThisDay(ctx: KindContext<Config>): Promise<ImmichOnThisDayData> {
  const raw = await rawMemories(ctx);
  if (!raw.list) return { years: [], note: raw.note };
  const nowYear = new Date().getFullYear();
  const byYear = new Map<number, ImmichOnThisDayData["years"][number]>();
  for (const m of raw.list) {
    const year = m.year ?? (m.yearsAgo !== null ? nowYear - m.yearsAgo : null);
    if (year === null || year >= nowYear) continue;
    const entry = byYear.get(year) ?? { id: m.id || String(year), year, yearsAgo: nowYear - year, photos: [] };
    for (const a of m.assets.filter(visible)) {
      if (entry.photos.length >= 12 || entry.photos.some((p) => p.id === a.id)) continue;
      const image = thumb(ctx, String(a.id), "preview");
      if (image) entry.photos.push({ id: String(a.id), kind: a.type === "VIDEO" ? "video" : "image", image, takenAt: time(a.localDateTime ?? a.fileCreatedAt) });
    }
    if (entry.photos.length) byYear.set(year, entry);
  }
  return { years: [...byYear.values()].sort((a, b) => b.year - a.year).slice(0, 10), note: null };
}

async function stats(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<ImmichStatsData> {
  const h = http(ctx);
  const [server, mem] = await Promise.all([
    h.json<unknown>("/api/server/statistics", { allow: [403] }),
    params.memories ? memories(ctx).catch((e) => ({ list: null, note: e instanceof UpstreamError ? e.message : "Memories couldn't be loaded." })) : Promise.resolve(null),
  ]);
  const base = { memories: mem?.list ?? null, memoriesNote: mem?.note ?? null };
  const s = obj(server);
  if (!num(s.__status)) {
    return {
      scope: "server",
      photos: num(s.photos) ?? 0,
      videos: num(s.videos) ?? 0,
      usageBytes: num(s.usage),
      users: arr<Record<string, unknown>>(s.usageByUser).map((u) => ({
        id: String(u.userId ?? ""),
        name: str(u.userName) ?? "Someone",
        photos: num(u.photos) ?? 0,
        videos: num(u.videos) ?? 0,
        usageBytes: num(u.usage) ?? 0,
        quotaBytes: num(u.quotaSizeInBytes),
      })),
      ...base,
    };
  }
  // Not an admin key (or missing server.statistics): fall back to the key owner's own library.
  const mine = obj(await h.json("/api/assets/statistics"));
  return { scope: "user", photos: num(mine.images) ?? 0, videos: num(mine.videos) ?? 0, usageBytes: null, users: [], ...base };
}

/** The newest photos and videos by when they were taken, as Immich's own timeline orders them. */
async function recent(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<ImmichRecentData> {
  const limit = Math.min(48, Math.max(1, Number(params.limit ?? 24)));
  const type = params.show === "photos" ? "IMAGE" : params.show === "videos" ? "VIDEO" : undefined;
  const res = obj(
    await http(ctx).json<unknown>("/api/search/metadata", {
      method: "POST",
      body: { size: limit, order: "desc", ...(type ? { type } : {}), withDeleted: false, visibility: "timeline" },
      allow: [400, 403],
    }),
  );
  const status = num(res.__status);
  if (status === 403) return { items: [], note: "This API key can't list photos (it needs the asset.read and asset.view permissions)." };
  if (status === 400) return { items: [], note: "This version of Immich doesn't offer photo search to other apps." };
  const items = arr<Record<string, unknown>>(obj(res.assets).items)
    .filter((a) => typeof a.id === "string" && !a.isTrashed)
    .map((a) => ({ id: String(a.id), kind: a.type === "VIDEO" ? ("video" as const) : ("image" as const), image: thumb(ctx, String(a.id)), takenAt: time(a.localDateTime ?? a.fileCreatedAt) }))
    .filter((a): a is ImmichRecentData["items"][number] => !!a.image);
  return { items, note: null };
}

// ------------------------------------------------------------------ universal search

const base = (ctx: KindContext<Config>) => ctx.baseUrl.replace(/\/+$/, "");

function yearOf(a: Record<string, unknown>): number | null {
  const t = time(a.localDateTime ?? a.fileCreatedAt);
  return t ? new Date(t).getUTCFullYear() : null;
}

/** A photo or video found by what's in it, linking to it in Immich. */
export function assetHit(ctx: KindContext<Config>, a: Record<string, unknown>): KindSearchHit | null {
  const id = str(a.id);
  if (!id || !UUID.test(id) || !visible(a)) return null;
  const exif = obj(a.exifInfo);
  const where = [str(exif.city), str(exif.country)].filter(Boolean).join(", ");
  const video = a.type === "VIDEO";
  const year = yearOf(a);
  return {
    id: `asset:${id.toLowerCase()}`,
    label: str(a.originalFileName) ?? (video ? "Video" : "Photo"),
    hint: [video ? "Video" : "Photo", where || null, year ? String(year) : null].filter(Boolean).join(" · "),
    url: `${base(ctx)}/photos/${id.toLowerCase()}`,
    type: video ? "video" : "photo",
    image: thumb(ctx, id),
  };
}

export function personHit(ctx: KindContext<Config>, p: Record<string, unknown>): KindSearchHit | null {
  const id = str(p.id);
  const name = str(p.name);
  if (!id || !name || p.isHidden === true) return null;
  return { id: `person:${id}`, label: name, hint: "Person", url: `${base(ctx)}/people/${encodeURIComponent(id)}`, type: "person" };
}

export function placeHit(ctx: KindContext<Config>, p: Record<string, unknown>): KindSearchHit | null {
  const name = str(p.name);
  if (!name) return null;
  const region = [str(p.admin1name), str(p.countryName)].filter((x) => x && x !== name).join(", ");
  const query = encodeURIComponent(JSON.stringify({ city: name }));
  return { id: `place:${name}:${region}`, label: name, hint: ["Place", region || null].filter(Boolean).join(" · "), url: `${base(ctx)}/search?query=${query}`, type: "place" };
}

export function albumHit(ctx: KindContext<Config>, a: Record<string, unknown>): KindSearchHit | null {
  const id = str(a.id);
  const name = str(a.albumName);
  if (!id || !name) return null;
  const n = num(a.assetCount);
  const cover = str(a.albumThumbnailAssetId);
  return {
    id: `album:${id}`,
    label: name,
    hint: ["Album", n !== null ? `${n} item${n === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "),
    url: `${base(ctx)}/albums/${encodeURIComponent(id)}`,
    type: "album",
    image: cover ? thumb(ctx, cover) : null,
  };
}

/**
 * People, places and albums by name, and photos by what's in them (Immich's smart search, so "beach
 * at sunset" works). Each part fails on its own: a library without machine learning still finds people.
 */
async function search(ctx: KindContext<Config>, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const h = http(ctx);
  const term = q.slice(0, 100);
  const settled = await Promise.allSettled([
    h.json<unknown>("/api/search/person", { query: { name: term, withHidden: false }, signal: opts.signal, timeoutMs: 1800 }),
    h.json<unknown>("/api/search/places", { query: { name: term }, signal: opts.signal, timeoutMs: 1800 }),
    h.json<unknown>("/api/albums", { signal: opts.signal, timeoutMs: 1800 }),
    term.length >= 3 ? h.json<unknown>("/api/search/smart", { method: "POST", body: { query: term, size: opts.limit * 2, withExif: true }, allow: [400], signal: opts.signal, timeoutMs: 1800 }) : Promise.resolve(null),
  ]);
  // Each part may fail on its own (an older Immich, a key without some permission); only when
  // everything fails is it worth telling the person why.
  if (settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  const [people, places, albums, smart] = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  if (opts.signal.aborted) return [];
  const query = prepare(q);
  const named = [
    ...arr<Record<string, unknown>>(people).slice(0, 5).map((p) => personHit(ctx, p)),
    ...arr<Record<string, unknown>>(albums)
      .filter((a) => matchScore(query, { label: str(a.albumName) ?? "" }) >= 0.5)
      .slice(0, 4)
      .map((a) => albumHit(ctx, a)),
    ...arr<Record<string, unknown>>(places).slice(0, 3).map((p) => placeHit(ctx, p)),
  ]
    .filter((x): x is KindSearchHit => !!x)
    .map((hit, i) => ({ hit, i, score: matchScore(query, { label: hit.label }) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const photos = arr<Record<string, unknown>>(obj(obj(smart).assets).items)
    .map((a) => assetHit(ctx, a))
    .filter((x): x is KindSearchHit => !!x);
  // Names that match well lead; photos follow in Immich's own order (most similar first).
  const strong = named.filter((x) => x.score >= 0.8).map((x) => x.hit);
  const weak = named.filter((x) => x.score < 0.8).map((x) => x.hit);
  return [...strong, ...photos, ...weak].slice(0, opts.limit);
}

export const def: KindDef<Config> = {
  kind: "immich",
  label: "Immich",
  description: "Photo and video counts, storage used per person, and “on this day” memories.",
  baseUrlLabel: "Immich address",
  baseUrlPlaceholder: "http://127.0.0.1:2283",
  keyHelp:
    "In Immich, open your avatar → Account Settings → API Keys → New API Key, name it “Gluon” and copy the key. Use an admin's account and give it the server.statistics permission to show everyone's totals (plus memory.read and asset.view for memories); otherwise the widget shows only that person's library.",
  fields: [
    { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["apiKey"],
  widgets: ["immich.stats", "immich.recent", "immich.onThisDay"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    req.headers["x-api-key"] = ctx.config.apiKey;
  },
  test: (ctx) =>
    runTest(async () => {
      const h = http(ctx);
      const ping = obj(await h.json("/api/server/ping", { noAuth: true }));
      if (ping.res !== "pong") throw new UpstreamError("That address answered, but it doesn't look like Immich.");
      const me = obj(await h.json("/api/users/me"));
      const v = obj(await h.json("/api/server/version", { noAuth: true }).catch(() => ({})));
      const version = num(v.major) !== null ? `${v.major}.${v.minor}.${v.patch}` : null;
      const st = obj(await h.json("/api/server/statistics", { allow: [403] }));
      const detail = num(st.__status)
        ? `This key can't read server-wide statistics, so the widget will show only ${str(me.name) ?? "this person"}'s library. Use an admin's key with the server.statistics permission to show everyone's.`
        : null;
      return ok(`Connected to Immich${version ? ` ${version}` : ""} as “${str(me.name) ?? str(me.email) ?? "unknown"}”.`, { version, detail });
    }),
  data: {
    "immich.stats": (ctx, p) => stats(ctx, p),
    "immich.recent": (ctx, p) => recent(ctx, p),
    "immich.onThisDay": (ctx) => onThisDay(ctx),
  },
  search,
  image: {
    schema: z.object({
      asset: z.string().regex(UUID),
      size: z.enum(["thumbnail", "preview"]).default("thumbnail"),
    }) as unknown as z.ZodType<Record<string, string | number>>,
    ref: (p) => String(p.asset).toLowerCase(),
    request: (_ctx, p) => ({ path: `/api/assets/${String(p.asset).toLowerCase()}/thumbnail`, query: { size: String(p.size) } }),
  },
};
