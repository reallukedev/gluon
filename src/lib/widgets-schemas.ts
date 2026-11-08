import "server-only";
import { z } from "zod";
import { HA_ENTITY_ID, HA_MAX_PICKED, type WidgetType } from "./widgets-types";

/** Widget config: what the server validates each widget's stored and sent config with. */

const url = z
  .string()
  .trim()
  .min(1, "Enter an address.")
  .max(2048, "That address is too long.")
  .refine((s) => /^https?:\/\//i.test(s), "Use an address that starts with http:// or https://.");

/** Calendar apps hand out webcal:// links; they're plain https underneath. */
const calendarUrl = z
  .string()
  .trim()
  .transform((s) => s.replace(/^webcals?:\/\//i, "https://"))
  .pipe(url);


/** Booleans arrive as strings in GET query params ("false" must stay false). */
const bool = (dflt: boolean) =>
  z.preprocess((v) => (typeof v === "string" ? v === "true" || v === "1" || v === "on" : v), z.boolean()).default(dflt);
/** Lists arrive as "a,b" in GET query params. */
const list = <T extends z.ZodType>(arr: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v), arr);

export const widgetConfigSchemas = {
  "jellyfin.nowPlaying": z.object({}).strip(),
  "jellyfin.recent": z
    .object({
      limit: z.coerce.number().int().min(1).max(30).default(12),
      /** Which kinds of things to show. */
      include: list(z.array(z.enum(["movie", "episode", "album"])).min(1).max(3)).default(["movie", "episode"]),
    })
    .strip(),
  "jellyfin.libraries": z.object({}).strip(),
  "immich.stats": z.object({ memories: bool(false) }).strip(),
  "immich.recent": z
    .object({
      limit: z.coerce.number().int().min(1).max(48).default(24),
      show: z.enum(["all", "photos", "videos"]).default("all"),
    })
    .strip(),
  "immich.onThisDay": z.object({}).strip(),
  "subsonic.nowPlaying": z.object({}).strip(),
  "subsonic.recent": z.object({ limit: z.coerce.number().int().min(1).max(30).default(12) }).strip(),
  "slskd.transfers": z.object({ limit: z.coerce.number().int().min(1).max(50).default(8) }).strip(),
  "homebridge.accessories": z
    .object({
      /** Only these accessories (uniqueIds), in this order. Empty = all. */
      only: list(z.array(z.string().max(128)).max(100)).default([]),
    })
    .strip(),
  "homeassistant.entities": z
    .object({
      /** Entity ids to show, in this order. Empty = nothing picked yet. */
      only: list(z.array(z.string().regex(HA_ENTITY_ID, "That isn't a Home Assistant entity.")).max(HA_MAX_PICKED)).default([]),
    })
    .strip(),
  "homeassistant.people": z.object({}).strip(),
  "coolify.deployments": z.object({ limit: z.coerce.number().int().min(1).max(20).default(6) }).strip(),
  "crafty.servers": z.object({}).strip(),
  "json.fields": z.object({}).strip(),
  weather: z
    .object({
      lat: z.coerce.number().min(-90).max(90),
      lon: z.coerce.number().min(-180).max(180),
      /** Place name to show, from the geocoding search. */
      name: z.string().trim().max(120).nullable().default(null),
      hours: z.coerce.number().int().min(1).max(24).default(12),
    })
    .strip(),
  calendar: z
    .object({
      url: calendarUrl,
      /** How far ahead to look (days). */
      days: z.coerce.number().int().min(1).max(14).default(7),
      limit: z.coerce.number().int().min(1).max(50).default(10),
      /** The viewer's IANA time zone (browser), used for floating times and all-day events. */
      tz: z.string().max(64).optional(),
    })
    .strip(),
  feed: z
    .object({
      url,
      limit: z.coerce.number().int().min(1).max(30).default(8),
    })
    .strip(),
  "link.status": z.object({ url }).strip(),
} satisfies Record<WidgetType, z.ZodType>;

export type WidgetConfig<T extends WidgetType> = z.input<(typeof widgetConfigSchemas)[T]>;
