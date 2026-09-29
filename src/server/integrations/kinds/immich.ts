import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef } from "./base";
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
  image: {
    schema: z.object({
      asset: z.string().regex(UUID),
      size: z.enum(["thumbnail", "preview"]).default("thumbnail"),
    }) as unknown as z.ZodType<Record<string, string | number>>,
    ref: (p) => String(p.asset).toLowerCase(),
    request: (_ctx, p) => ({ path: `/api/assets/${String(p.asset).toLowerCase()}/thumbnail`, query: { size: String(p.size) } }),
  },
};
