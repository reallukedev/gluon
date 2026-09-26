import "server-only";
import { AppError, badRequest } from "../errors";
import type { User } from "../auth/users";
import { cached } from "../integrations/cache";
import { KINDS } from "../integrations/registry";
import { contextFor, noteStatus, readableRecord } from "../integrations/store";
import type { NetPolicy } from "../integrations/net";
import { calendar, feed, linkStatus, weather } from "./sources";
import {
  WIDGET_REFRESH_MS,
  WIDGET_SOURCE,
  WIDGET_TYPES,
  widgetConfigSchemas,
  type WidgetBatchItem,
  type WidgetRequest,
  type WidgetResponse,
  type WidgetType,
} from "@/lib/widgets-types";

/** How long a last-good answer may be shown (marked stale) while the source is failing. 0 = never. */
const STALE_MS: Record<WidgetType, number> = {
  "jellyfin.nowPlaying": 0,
  "jellyfin.recent": 30 * 60_000,
  "jellyfin.libraries": 60 * 60_000,
  "immich.stats": 60 * 60_000,
  "subsonic.nowPlaying": 0,
  "subsonic.recent": 30 * 60_000,
  "slskd.transfers": 0,
  "homebridge.accessories": 2 * 60_000,
  "json.fields": 10 * 60_000,
  weather: 3 * 60 * 60_000,
  calendar: 6 * 60 * 60_000,
  feed: 6 * 60 * 60_000,
  "link.status": 0,
};

export function isWidgetType(t: unknown): t is WidgetType {
  return typeof t === "string" && (WIDGET_TYPES as readonly string[]).includes(t);
}

/** Stable JSON for cache keys (sorted keys). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// Members' personal sources: at most 30 *uncached* fetches per minute each, so the server can't be used to
// crawl lots of addresses. Cache hits are free.
type G = typeof globalThis & { __gluonWidgetBuckets?: Map<string, { tokens: number; at: number }> };
const g = globalThis as G;
const buckets = (g.__gluonWidgetBuckets ??= new Map());
function spend(userId: string) {
  const now = Date.now();
  const b = buckets.get(userId) ?? { tokens: 30, at: now };
  b.tokens = Math.min(30, b.tokens + ((now - b.at) / 60_000) * 30);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(userId, b);
    throw new AppError("rate_limited", "Too many new addresses at once. Widgets will catch up in a minute.", 429);
  }
  b.tokens -= 1;
  buckets.set(userId, b);
}

function parseConfig(type: WidgetType, raw: unknown): Record<string, unknown> {
  const parsed = widgetConfigSchemas[type].safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    const msg = issue?.message && !issue.message.startsWith("Invalid") ? issue.message : `Check the widget's ${field || "settings"}.`;
    throw badRequest(msg, field ? { field: `config.${field}` } : undefined);
  }
  return parsed.data as Record<string, unknown>;
}

export async function widgetData(user: User, req: WidgetRequest): Promise<WidgetResponse> {
  if (!isWidgetType(req.type)) throw badRequest("Gluon doesn't know that kind of widget.");
  const type = req.type;
  const config = parseConfig(type, req.config);
  const ttl = WIDGET_REFRESH_MS[type];
  const source = WIDGET_SOURCE[type];

  if (source) {
    if (!req.integration) throw badRequest("Choose which connected app this widget shows.", { field: "integration" });
    const rec = readableRecord(user, req.integration);
    if (rec.kind !== source) throw badRequest("That connected app can't feed this kind of widget.", { field: "integration" });
    const def = KINDS[rec.kind];
    const fn = def.data[type] as ((ctx: ReturnType<typeof contextFor>, p: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (!fn) throw badRequest("That connected app can't feed this kind of widget.");
    const ctx = contextFor(rec);
    const key = `int:${rec.id}:${rec.updatedAt}:${type}:${stable(config)}`;
    const r = await cached(
      key,
      ttl,
      async () => {
        try {
          const v = await fn(ctx, config);
          noteStatus(rec.id, true, null);
          return v;
        } catch (e) {
          if (e instanceof AppError) noteStatus(rec.id, false, e.message);
          throw e;
        }
      },
      { staleMs: STALE_MS[type] },
    );
    return { type, data: r.value as WidgetResponse["data"], fetchedAt: r.fetchedAt, refreshMs: ttl, stale: r.stale };
  }

  // Personal sources. Members may not reach the server itself; admins may (they can anyway).
  const policy: NetPolicy = user.role === "admin" ? "trusted" : "member";
  const key = `p:${policy}:${type}:${stable(config)}`;
  const load = async (): Promise<unknown> => {
    if (policy === "member") spend(user.id);
    switch (type) {
      case "weather":
        return weather(config as { lat: number; lon: number; name: string | null; hours: number });
      case "calendar":
        return calendar(config as { url: string; days: number; limit: number; tz?: string }, policy);
      case "feed":
        return feed(config as { url: string; limit: number }, policy);
      case "link.status":
        return linkStatus((config as { url: string }).url, policy);
      default:
        throw badRequest("Gluon doesn't know that kind of widget.");
    }
  };
  const r = await cached(key, ttl, load, { staleMs: STALE_MS[type] });
  return { type, data: r.value as WidgetResponse["data"], fetchedAt: r.fetchedAt, refreshMs: ttl, stale: r.stale };
}

export async function widgetBatch(user: User, reqs: WidgetRequest[]): Promise<WidgetBatchItem[]> {
  return Promise.all(
    reqs.map(async (req, i): Promise<WidgetBatchItem> => {
      const key = req.key ?? String(i);
      try {
        return { key, ok: true, ...(await widgetData(user, req)) };
      } catch (e) {
        const err =
          e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Something went wrong on the server. It's been logged." };
        if (!(e instanceof AppError)) console.error("[gluon] widget data failed", e);
        return { key, ok: false, type: isWidgetType(req.type) ? req.type : null, error: err };
      }
    }),
  );
}
