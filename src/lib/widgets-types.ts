/**
 * Shared types for integrations (connected apps) and live widget data.
 * Isomorphic: no server imports. The Home widget grid is built from these shapes.
 *
 * Conventions for every data shape below:
 * - Timestamps are epoch milliseconds (UTC). Durations are milliseconds unless the name says otherwise.
 * - Temperatures are °C, wind km/h, precipitation mm, sizes bytes, speeds bytes/second. Format on the client with
 *   `src/lib/format.ts` and the person's prefs.
 * - `image` fields are same-origin URLs to the image proxy (`/api/integrations/<id>/image?...`), ready for <img src>.
 *   Append nothing; the `w` in the URL is already a sensible size for the widget.
 * - Anything that may be missing is `null`, never `undefined`.
 */
import { z } from "zod";
import type { LineState } from "./types";
import type { LocalWidgetAvailability } from "./home-widgets-types";

// =====================================================================================================================
// Integrations
// =====================================================================================================================

export const INTEGRATION_KINDS = ["jellyfin", "immich", "subsonic", "slskd", "homebridge", "homeassistant", "coolify", "generic-json"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** One input on the "connect an app" form. */
export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "password" | "boolean" | "select" | "headers" | "fields";
  required: boolean;
  /** Stored encrypted and never sent back; responses show `secrets[key]` instead. Leave empty on edit to keep. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  /** Only show when another field has one of these values, e.g. subsonic `auth`. */
  showWhen?: { key: string; in: string[] };
}

/** GET /api/integrations/kinds: everything the admin form needs to render one kind. */
export interface IntegrationKindInfo {
  kind: IntegrationKind;
  label: string;
  description: string;
  /** Label + placeholder for the address input (the `baseUrl` of the integration). */
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  fields: IntegrationField[];
  /** Plain-language steps for finding the key/credentials inside that app. */
  keyHelp: string;
  widgets: WidgetType[];
}

export interface SecretState {
  set: boolean;
  /** e.g. "••••3f2a": enough to recognise which key is stored. null when not set or too short to hint. */
  hint: string | null;
}

/** Admin view of a saved integration. Secrets are never included. */
export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string;
  /** Compose project / container the integration talks to (from suggestions), if known. */
  appId: string | null;
  /** When true every signed-in person may use it in their widgets; otherwise only admins. */
  shared: boolean;
  /** Non-secret settings. For generic-json, `headers` values are replaced by "" (names kept). */
  config: Record<string, unknown>;
  /** Which secret fields are stored. */
  secrets: Record<string, SecretState>;
  widgets: WidgetType[];
  /** Last result seen by Gluon (tests and widget fetches), in memory since the last restart. */
  status: IntegrationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationStatus {
  ok: boolean | null;
  message: string | null;
  checkedAt: number | null;
}

/** What members get from GET /api/integrations (shared integrations only). */
export interface IntegrationRef {
  id: string;
  kind: IntegrationKind;
  name: string;
  widgets: WidgetType[];
  /** Where to open the app in a browser, if Gluon knows it. */
  links: { home: string | null; away: string | null };
  /** The installed app this connection reads from, and its state right now (null when unknown). */
  appId: string | null;
  appLine: LineState | null;
}

/** POST /api/integrations/test and /api/integrations/[id]/test. Always 200; `ok` says whether it worked. */
export interface IntegrationTestResult {
  ok: boolean;
  /** One sentence for people: "Connected to Jellyfin 10.11.10 as “leech”." / "Jellyfin answered 401: the API key is wrong." */
  message: string;
  /** Optional extra line (e.g. a missing permission that limits one widget). */
  detail: string | null;
  version: string | null;
  serverName: string | null;
  /** Choices discovered while testing, for follow-up fields (e.g. Jellyfin users for `userId`). */
  options: { users?: { id: string; name: string }[] } | null;
  /** Generic JSON only: the evaluated fields, so the form can preview them. */
  preview: JsonFieldValue[] | null;
  ms: number;
}

/** GET /api/integrations/suggestions: apps on this server Gluon knows how to connect to. */
export interface IntegrationSuggestion {
  /** Stable key: `${kind}:${appId}:${port}`. */
  key: string;
  kind: IntegrationKind;
  /** Suggested integration name, e.g. "Jellyfin". */
  name: string;
  appId: string;
  appName: string;
  icon: string | null;
  baseUrl: string;
  /** Where to find the API key/credentials in that app, in plain steps. */
  keyHelp: string;
  /** Extra context, e.g. "Octo passes requests on to Navidrome; either works." */
  note: string | null;
  running: boolean;
  /** An integration with the same kind and address already exists. */
  alreadyAdded: boolean;
  /** Prefill for non-secret fields. */
  config: Record<string, unknown>;
}

// =====================================================================================================================
// Widgets
// =====================================================================================================================

export const WIDGET_TYPES = [
  "jellyfin.nowPlaying",
  "jellyfin.recent",
  "jellyfin.libraries",
  "immich.stats",
  "immich.recent",
  "immich.onThisDay",
  "subsonic.nowPlaying",
  "subsonic.recent",
  "slskd.transfers",
  "homebridge.accessories",
  "homeassistant.entities",
  "homeassistant.people",
  "coolify.deployments",
  "json.fields",
  "weather",
  "calendar",
  "feed",
  "link.status",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Which integration kind backs each widget type; `null` = a personal source configured in the widget itself. */
export const WIDGET_SOURCE: Record<WidgetType, IntegrationKind | null> = {
  "jellyfin.nowPlaying": "jellyfin",
  "jellyfin.recent": "jellyfin",
  "jellyfin.libraries": "jellyfin",
  "immich.stats": "immich",
  "immich.recent": "immich",
  "immich.onThisDay": "immich",
  "subsonic.nowPlaying": "subsonic",
  "subsonic.recent": "subsonic",
  "slskd.transfers": "slskd",
  "homebridge.accessories": "homebridge",
  "homeassistant.entities": "homeassistant",
  "homeassistant.people": "homeassistant",
  "coolify.deployments": "coolify",
  "json.fields": "generic-json",
  weather: null,
  calendar: null,
  feed: null,
  "link.status": null,
};

/** How often the client should poll each type (the server caches for the same time). */
export const WIDGET_REFRESH_MS: Record<WidgetType, number> = {
  "jellyfin.nowPlaying": 5_000,
  "jellyfin.recent": 60_000,
  "jellyfin.libraries": 300_000,
  "immich.stats": 300_000,
  "immich.recent": 120_000,
  "immich.onThisDay": 30 * 60_000,
  "subsonic.nowPlaying": 5_000,
  "subsonic.recent": 60_000,
  "slskd.transfers": 5_000,
  "homebridge.accessories": 15_000,
  "homeassistant.entities": 10_000,
  "homeassistant.people": 30_000,
  "coolify.deployments": 10_000,
  "json.fields": 30_000,
  weather: 900_000,
  calendar: 900_000,
  feed: 900_000,
  "link.status": 60_000,
};

// ------------------------------------------------------------------ widget config (what the widget stores + sends)
//
// Integration widgets send `{ type, integration: "<id>", config }`; personal widgets send `{ type, config }`.
// These schemas are what the server validates; use them in the widget settings form too.

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

/** `light.kitchen`, `sensor.living_room_temperature`: Home Assistant's own format. */
export const HA_ENTITY_ID = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,190}$/;
/** Most entities one Home Assistant widget may show. */
export const HA_MAX_PICKED = 60;

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

// ------------------------------------------------------------------ request / response envelopes

/**
 * GET  /api/widgets/data?type=<type>&integration=<id>&<config fields as query params>
 * POST /api/widgets/data  body: WidgetRequest                      → WidgetResponse
 * POST /api/widgets/data  body: { widgets: WidgetRequest[] (≤40) } → WidgetBatchResponse
 * Personal sources (weather/calendar/feed/link.status) should use POST so URLs stay out of logs and history.
 */
export interface WidgetRequest {
  /** Echoed back in batch responses. */
  key?: string;
  type: WidgetType;
  integration?: string;
  config?: Record<string, unknown>;
}

export interface WidgetResponse<T extends WidgetType = WidgetType> {
  type: T;
  data: WidgetDataMap[T];
  /** When the upstream data was fetched (may be earlier than now because of the cache). */
  fetchedAt: number;
  /** Suggested polling interval. */
  refreshMs: number;
  /** Set when the upstream failed and this is the last good answer (shown with a quiet "last updated" note). */
  stale: { message: string } | null;
}

export type WidgetBatchItem =
  | ({ key: string; ok: true } & WidgetResponse)
  | { key: string; ok: false; type: WidgetType | null; error: { code: string; message: string } };

export interface WidgetBatchResponse {
  results: WidgetBatchItem[];
}

/**
 * One part of an installed app that Gluon can read from (Jellyfin in the Jellyfin app; Navidrome and slskd in Octo).
 * Members only get services that are connected and shared; `connect` is admin-only.
 */
export interface AppService {
  /** `${kind}:${appId}` */
  key: string;
  kind: IntegrationKind;
  /** "Jellyfin", "Navidrome", "slskd". */
  label: string;
  /** State of the container that serves it. */
  line: LineState;
  widgets: WidgetType[];
  /** connected = a working (or untested) connection; broken = the last check failed; none = not connected. */
  state: "connected" | "broken" | "none";
  integrationId: string | null;
  /** Why it's broken, in a sentence (admins only). */
  message: string | null;
  /** How to connect it (admins only): the address Gluon found and what it can do. */
  connect: {
    baseUrl: string;
    config: Record<string, unknown>;
    note: string | null;
    /** The app can make its own API key when an admin signs in (Jellyfin, Immich). */
    signIn: boolean;
    keyHelp: string;
  } | null;
}

/** An installed app as the widget catalog sees it: everything needed for the keyless App widget, plus its services. */
export interface InstalledApp {
  appId: string;
  name: string;
  icon: string | null;
  line: LineState;
  summary: string;
  urls: { home: string | null; away: string | null };
  /** Where it was installed from ("umbrel", "casaos", "compose", "docker"), to tell two copies apart. */
  source: string;
  /** Empty for apps Gluon can't read from (they still get the App widget). */
  services: AppService[];
  /** Another installed app provides the same services and is running (e.g. a stopped CasaOS copy). */
  duplicate: boolean;
}

/** POST /api/integrations/sign-in: connect Jellyfin or Immich by signing in once; Gluon keeps only the key it makes. */
export const SIGN_IN_KINDS = ["jellyfin", "immich"] as const;
export type SignInKind = (typeof SIGN_IN_KINDS)[number];

export interface SignInResult {
  integration: Integration;
  test: IntegrationTestResult;
  /** The account Gluon signed in as, for the success message. */
  account: string;
}

/** GET /api/widgets/catalog: what this person can add. */
export interface WidgetCatalog {
  /** Installed apps this person can see, integrable ones first. */
  apps: InstalledApp[];
  types: {
    type: WidgetType;
    label: string;
    description: string;
    source: IntegrationKind | null;
    refreshMs: number;
    /** Integrations this person may use for it (empty for personal sources). */
    integrations: IntegrationRef[];
    /** false when an integration is needed and none is available to this person. */
    available: boolean;
  }[];
  /** Home widgets that read this machine (Internet, Power…): whether they work here, and why not. */
  local: LocalWidgetAvailability[];
}

/** GET /api/widgets/geocode?q=berlin */
export interface GeocodeResult {
  results: {
    id: number;
    name: string;
    /** "State of Berlin, Germany" */
    region: string | null;
    country: string | null;
    countryCode: string | null;
    lat: number;
    lon: number;
    timezone: string | null;
  }[];
}

// ------------------------------------------------------------------ Jellyfin

export type MediaKind = "movie" | "series" | "episode" | "album" | "track" | "video" | "other";

export interface NowPlayingSession {
  id: string;
  user: string | null;
  /** App the person is watching in, e.g. "Jellyfin Web". */
  client: string | null;
  device: string | null;
  item: {
    id: string;
    kind: MediaKind;
    /** Episode/track/movie title. */
    title: string;
    /** "Show name · S2 E5", "Artist · Album", or null. */
    subtitle: string | null;
    year: number | null;
    image: string | null;
  };
  positionMs: number | null;
  durationMs: number | null;
  /** 0…1 */
  progress: number | null;
  paused: boolean;
  /** "direct" plays the file as is; "transcode" means the server converts it on the fly (uses CPU). */
  playMethod: "direct" | "directStream" | "transcode" | null;
  /** Plain reason when transcoding, e.g. "Audio codec not supported". */
  transcodeReason: string | null;
}

export interface JellyfinNowPlayingData {
  sessions: NowPlayingSession[];
  /** Sessions currently playing (paused included). */
  activeStreams: number;
  transcoding: number;
}

export interface RecentMediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  /** Series name + "3 new episodes", or album artist. */
  subtitle: string | null;
  year: number | null;
  addedAt: number | null;
  image: string | null;
  /** For collapsed episodes: how many new episodes of this series. */
  count: number | null;
}

export interface JellyfinRecentData {
  items: RecentMediaItem[];
}

export interface JellyfinLibrariesData {
  libraries: {
    id: string;
    name: string;
    kind: "movies" | "tvshows" | "music" | "musicvideos" | "homevideos" | "boxsets" | "books" | "mixed" | "other";
    /** Main items in the library (movies, series, albums…), null if Jellyfin wouldn't say. */
    count: number | null;
    image: string | null;
  }[];
  counts: {
    movies: number;
    series: number;
    episodes: number;
    albums: number;
    songs: number;
    artists: number;
    musicVideos: number;
    books: number;
  };
  activeStreams: number;
  /** Something about Jellyfin itself that makes these numbers misleading, with what to do about it. */
  note?: string | null;
}

// ------------------------------------------------------------------ Immich

export interface ImmichStatsData {
  /** "server" = everyone's library (admin key); "user" = only the key owner's library. */
  scope: "server" | "user";
  photos: number;
  videos: number;
  /** null in "user" scope (Immich doesn't report it per user without admin). */
  usageBytes: number | null;
  users: { id: string; name: string; photos: number; videos: number; usageBytes: number; quotaBytes: number | null }[];
  /** "On this day" memories when requested and allowed, else null. */
  memories: ImmichMemory[] | null;
  /** Why memories are null although requested (e.g. missing permission). */
  memoriesNote: string | null;
}

export interface ImmichRecentData {
  items: { id: string; kind: "image" | "video"; image: string; takenAt: number | null }[];
  /** Why nothing could be shown although Immich answered (e.g. the key lacks a permission). */
  note: string | null;
}

/** "On this day": photos taken on today's date in earlier years, one year per entry, newest year first. */
export interface ImmichOnThisDayData {
  years: {
    id: string;
    year: number;
    /** How many years ago (from the server's date). */
    yearsAgo: number;
    photos: { id: string; kind: "image" | "video"; image: string; takenAt: number | null }[];
  }[];
  /** Why nothing could be shown although Immich answered (e.g. a missing permission, an old Immich). */
  note: string | null;
}

export interface ImmichMemory {
  id: string;
  /** "3 years ago" */
  title: string;
  year: number | null;
  assets: { id: string; kind: "image" | "video"; image: string }[];
}

// ------------------------------------------------------------------ Subsonic (Navidrome, Octo…)

export interface SubsonicNowPlayingData {
  entries: {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    image: string | null;
    durationMs: number | null;
    user: string | null;
    player: string | null;
    /** How long ago the track started, from the server's point of view. */
    minutesAgo: number | null;
  }[];
}

export interface SubsonicRecentData {
  albums: {
    id: string;
    title: string;
    artist: string | null;
    year: number | null;
    addedAt: number | null;
    songs: number | null;
    image: string | null;
  }[];
  /** null when the server doesn't support scan status. */
  scan: { scanning: boolean; count: number | null; folderCount: number | null; lastScan: number | null } | null;
}

// ------------------------------------------------------------------ slskd

export interface SlskdTransfer {
  id: string;
  direction: "download" | "upload";
  user: string;
  /** File name without folders. */
  file: string;
  folder: string | null;
  sizeBytes: number;
  transferredBytes: number;
  /** 0…100 */
  percent: number;
  speedBps: number | null;
  state: "active" | "queued" | "done" | "failed";
  /** slskd's own words, e.g. "Queued, Remotely", "Completed, Errored". */
  stateLabel: string;
  placeInQueue: number | null;
  remainingSec: number | null;
}

export interface SlskdTransfersData {
  connected: boolean | null;
  username: string | null;
  downloads: { active: number; queued: number; failed: number; speedBps: number };
  uploads: { active: number; queued: number; speedBps: number };
  /** Active first, then queued, then recently finished/failed; limited to the widget's `limit`. */
  items: SlskdTransfer[];
}

// ------------------------------------------------------------------ Homebridge

export type AccessoryKind =
  | "light"
  | "switch"
  | "outlet"
  | "fan"
  | "thermostat"
  | "temperature"
  | "humidity"
  | "contact"
  | "motion"
  | "lock"
  | "cover"
  | "tv"
  | "air"
  | "other";

export interface HomebridgeAccessory {
  /** Homebridge uniqueId. */
  id: string;
  name: string;
  room: string | null;
  kind: AccessoryKind;
  /** Homebridge's service type, e.g. "Lightbulb". */
  type: string;
  on: boolean | null;
  /** 0…100 */
  brightness: number | null;
  temperature: number | null;
  targetTemperature: number | null;
  humidity: number | null;
  contact: "open" | "closed" | null;
  motion: boolean | null;
  locked: boolean | null;
  /** Blinds / garage position 0…100. */
  position: number | null;
  batteryLow: boolean | null;
}

export interface HomebridgeAccessoriesData {
  instance: string | null;
  accessories: HomebridgeAccessory[];
  rooms: string[];
}

// ------------------------------------------------------------------ Home Assistant

/** Which icon a thing gets: the domain, refined by its device class (a door sensor, a garage cover). */
export type HaIcon =
  | "light"
  | "switch"
  | "outlet"
  | "fan"
  | "cover"
  | "garage"
  | "blind"
  | "climate"
  | "lock"
  | "scene"
  | "script"
  | "button"
  | "temperature"
  | "humidity"
  | "power"
  | "energy"
  | "battery"
  | "door"
  | "window"
  | "motion"
  | "presence"
  | "leak"
  | "smoke"
  | "media"
  | "tv"
  | "vacuum"
  | "alarm"
  | "person"
  | "valve"
  | "sensor";

/**
 * What pressing a thing does. `toggle` switches it on or off, `cover` opens or closes it, `run` starts a scene or
 * script, `press` presses a button. null = it can only be looked at from Gluon (locks, alarms, thermostats, sensors).
 */
export type HaControl = "toggle" | "cover" | "run" | "press";

export interface HomeAssistantEntity {
  /** entity_id, e.g. "light.kitchen". */
  id: string;
  domain: string;
  name: string;
  area: string | null;
  icon: HaIcon;
  /** The state in words: "On", "Open", "Locked", "Heating", "Motion". null when a number or a time says it better. */
  words: string | null;
  /** A reading: sensor value, brightness or position in %, a thermostat's current temperature. */
  value: number | null;
  /** Unit of `value` and `target` as Home Assistant reports it ("°C", "%", "kWh"). Temperatures are converted on the client. */
  unit: string | null;
  /** A thermostat's or humidifier's target. */
  target: number | null;
  /** Extra line: what a media player is playing. */
  detail: string | null;
  /** Lit, open, running, playing, motion seen: drawn as an active tile. */
  active: boolean;
  /** Home Assistant says "unavailable" or "unknown". */
  unavailable: boolean;
  control: HaControl | null;
  /** For toggle and cover controls: whether it's on / open right now. */
  on: boolean | null;
  /** An admin shared it with the household: members may see it. */
  shared: boolean;
  /** An admin let household members press it (never for locks, alarms, garage doors, gates or doors). Admins always can. */
  household: boolean;
  changedAt: number | null;
  /** Scenes, scripts and buttons: when it was last used. */
  lastUsedAt: number | null;
}

export interface HomeAssistantEntitiesData {
  /** The home's name in Home Assistant ("Home"). */
  location: string | null;
  /** The picked entities that still exist, in the picked order. */
  entities: HomeAssistantEntity[];
  /** Picked entity ids Home Assistant doesn't have any more. */
  missing: string[];
  /**
   * Household members only: picked ids an admin hasn't shared with the household. Nothing about them is sent, not
   * even whether they exist; the widget shows a "not shared with you" tile in their place.
   */
  notShared: string[];
}

export interface HomeAssistantPerson {
  id: string;
  name: string;
  /** home, away (not_home), a named zone ("Work"), or unknown. */
  where: "home" | "away" | "zone" | "unknown";
  /** The zone's name when `where` is "zone". */
  place: string | null;
  since: number | null;
  image: string | null;
}

export interface HomeAssistantPeopleData {
  people: HomeAssistantPerson[];
  home: number;
  /** An admin chose to show where people are (zone names). Off by default; when off, no place names are sent. */
  places: boolean;
}

/** GET /api/integrations/[id]/entities: what a Home Assistant widget can show, for its settings. */
export interface HomeAssistantPickable {
  id: string;
  name: string;
  domain: string;
  area: string | null;
  icon: HaIcon;
  control: HaControl | null;
  /** Shared with the household to look at. */
  shared: boolean;
  /** Household members may press it. */
  household: boolean;
  /** Members could be allowed to press it at all (false for locks, alarms, garage doors, gates and doors). */
  memberPressable: boolean;
}

export interface HomeAssistantPickableList {
  entities: HomeAssistantPickable[];
  areas: string[];
  /** Why rooms are missing (the token isn't an administrator's), else null. */
  areasNote: string | null;
}

/** POST /api/integrations/[id]/control */
export const HA_ACTIONS = ["turn_on", "turn_off", "open", "close", "run", "press"] as const;
export type HaAction = (typeof HA_ACTIONS)[number];

export interface HomeAssistantControlResult {
  /** The entity as Home Assistant reports it after the change (null if it couldn't say). */
  entity: HomeAssistantEntity | null;
}

/** PUT /api/integrations/[id]/household-controls (admin): what household members may see, and what they may press. */
export interface HouseholdControlsBody {
  see?: { allow: string[]; deny: string[] };
  press?: { allow: string[]; deny: string[] };
}

/** PUT /api/integrations/[id]/show-places (admin): whether Who's home names the places people are. */
export interface ShowPlacesBody {
  show: boolean;
}

// ------------------------------------------------------------------ Coolify

export type CoolifyDeploymentStatus = "queued" | "in_progress" | "finished" | "failed" | "cancelled";

export interface CoolifyDeployment {
  /** deployment_uuid */
  id: string;
  app: string;
  status: CoolifyDeploymentStatus;
  /** Short commit hash. */
  commit: string | null;
  /** First line of the commit message. */
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Path of the deployment's page inside Coolify ("/project/…/deployment/…"), to join with Coolify's address. */
  path: string | null;
  server: string | null;
  trigger: "webhook" | "api" | "manual" | null;
}

export interface CoolifyResource {
  id: string;
  name: string;
  type: "application" | "service" | "database" | "other";
  line: LineState;
  /** Coolify's own words, e.g. "exited:unhealthy". */
  status: string;
}

export interface CoolifyDeploymentsData {
  version: string | null;
  /** Queued and running deployments, oldest first. */
  active: CoolifyDeployment[];
  /** Finished, failed and cancelled ones, newest first, limited to the widget's `limit`. */
  recent: CoolifyDeployment[];
  resources: {
    total: number;
    running: number;
    /** Resources that aren't running or aren't healthy. */
    problems: CoolifyResource[];
  };
  /** Why the history is missing (an older Coolify, a token without read access), else null. */
  historyNote: string | null;
}

// ------------------------------------------------------------------ Generic JSON

export const JSON_FIELD_FORMATS = ["text", "number", "bytes", "percent", "duration", "date", "relative", "boolean"] as const;
export type JsonFieldFormat = (typeof JSON_FIELD_FORMATS)[number];

export interface JsonFieldValue {
  label: string;
  format: JsonFieldFormat;
  /** Raw value found at the path (arrays become their length), or null if nothing was there. */
  value: string | number | boolean | null;
  /** Formatted with default settings, for quick display. Re-format `value` with prefs if you like. */
  display: string;
  /** Set when the path found nothing. */
  missing: boolean;
}

export interface JsonFieldsData {
  fields: JsonFieldValue[];
}

// ------------------------------------------------------------------ Weather (Open-Meteo)

export type WeatherIcon = "clear" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "freezing-rain" | "snow" | "showers" | "snow-showers" | "thunder";

export interface WeatherData {
  place: string | null;
  /** IANA zone of the place. */
  timezone: string;
  current: {
    at: number;
    temperature: number;
    feelsLike: number | null;
    humidity: number | null;
    windKph: number | null;
    precipitationMm: number | null;
    code: number;
    condition: string;
    icon: WeatherIcon;
    isDay: boolean;
  };
  today: {
    high: number;
    low: number;
    code: number;
    condition: string;
    icon: WeatherIcon;
    precipitationChance: number | null;
    sunrise: number | null;
    sunset: number | null;
  };
  tomorrow: { high: number; low: number; code: number; condition: string; icon: WeatherIcon; precipitationChance: number | null } | null;
  hours: { at: number; temperature: number; code: number; icon: WeatherIcon; precipitationChance: number | null; isDay: boolean }[];
}

// ------------------------------------------------------------------ Calendar (ICS)

export interface CalendarEvent {
  /** UID + occurrence start; stable across refreshes. */
  id: string;
  title: string;
  /** Start instant. For all-day events: midnight at the start of `startDate` in the requested zone. */
  start: number;
  end: number | null;
  allDay: boolean;
  /** All-day only: "2026-09-25" (inclusive): show these instead of converting `start`. */
  startDate: string | null;
  /** All-day only: last day, inclusive. */
  endDate: string | null;
  location: string | null;
  recurring: boolean;
  /** Happening right now. */
  ongoing: boolean;
}

export interface CalendarData {
  name: string | null;
  events: CalendarEvent[];
  /** Zone used for floating times and all-day dates. */
  timezone: string;
}

// ------------------------------------------------------------------ Feed (RSS / Atom / JSON Feed)

export interface FeedItem {
  id: string;
  title: string;
  url: string | null;
  publishedAt: number | null;
  /** Plain text, at most ~280 characters. */
  summary: string | null;
  author: string | null;
  /** Remote image URL from the feed (http/https only), or null. Not proxied. */
  image: string | null;
}

export interface FeedData {
  title: string | null;
  siteUrl: string | null;
  items: FeedItem[];
}

// ------------------------------------------------------------------ Link status

export interface LinkStatusData {
  url: string;
  up: boolean;
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  latencyMs: number | null;
  /** "Responding (200) in 45 ms" / "Didn't answer within 5 seconds" */
  message: string;
  checkedAt: number;
}

// ------------------------------------------------------------------

export interface WidgetDataMap {
  "jellyfin.nowPlaying": JellyfinNowPlayingData;
  "jellyfin.recent": JellyfinRecentData;
  "jellyfin.libraries": JellyfinLibrariesData;
  "immich.stats": ImmichStatsData;
  "immich.recent": ImmichRecentData;
  "immich.onThisDay": ImmichOnThisDayData;
  "subsonic.nowPlaying": SubsonicNowPlayingData;
  "subsonic.recent": SubsonicRecentData;
  "slskd.transfers": SlskdTransfersData;
  "homebridge.accessories": HomebridgeAccessoriesData;
  "homeassistant.entities": HomeAssistantEntitiesData;
  "homeassistant.people": HomeAssistantPeopleData;
  "coolify.deployments": CoolifyDeploymentsData;
  "json.fields": JsonFieldsData;
  weather: WeatherData;
  calendar: CalendarData;
  feed: FeedData;
  "link.status": LinkStatusData;
}

export const WIDGET_LABELS: Record<WidgetType, { label: string; description: string }> = {
  "jellyfin.nowPlaying": { label: "Now watching", description: "Who is watching what on Jellyfin right now." },
  "jellyfin.recent": { label: "New on Jellyfin", description: "Recently added movies, episodes and albums." },
  "jellyfin.libraries": { label: "Jellyfin libraries", description: "How much is in each library." },
  "immich.stats": { label: "Photos", description: "Photo and video counts from Immich, with optional memories." },
  "immich.recent": { label: "Latest photos", description: "The newest photos and videos in Immich." },
  "immich.onThisDay": { label: "On this day", description: "Photos taken on this date in past years, from Immich." },
  "subsonic.nowPlaying": { label: "Now playing", description: "What people are listening to." },
  "subsonic.recent": { label: "New music", description: "Recently added albums." },
  "slskd.transfers": { label: "Soulseek transfers", description: "Downloads and uploads in progress." },
  "homebridge.accessories": { label: "Home accessories", description: "Lights, switches and sensors from Homebridge." },
  "homeassistant.entities": { label: "Home controls", description: "Lights, switches, scenes and sensors you pick from Home Assistant." },
  "homeassistant.people": { label: "Who's home", description: "Who is home and who is out, from Home Assistant." },
  "coolify.deployments": { label: "Deployments", description: "What Coolify is deploying, what failed, and what isn't running." },
  "json.fields": { label: "Custom values", description: "Numbers pulled from any JSON address." },
  weather: { label: "Weather", description: "Current weather and the next hours for a place." },
  calendar: { label: "Calendar", description: "Upcoming events from a calendar link (ICS)." },
  feed: { label: "News feed", description: "Latest posts from an RSS or Atom feed." },
  "link.status": { label: "Link status", description: "Whether a web address is answering." },
};
