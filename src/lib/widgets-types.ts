/**
 * Shared, isomorphic types for connected apps and live widget data. Conventions for every shape below:
 * timestamps are epoch ms (UTC), durations ms unless the name says otherwise; °C, km/h, mm, bytes, bytes/second;
 * `image` fields are same-origin image proxy URLs already sized for the widget; anything missing is `null`.
 */
import type { WidgetConfig } from "./widgets-schemas";
import type { LineState } from "./types";
import type { LocalWidgetAvailability } from "./home-widgets-types";

export type { WidgetConfig };

export const INTEGRATION_KINDS = ["jellyfin", "immich", "subsonic", "slskd", "homebridge", "homeassistant", "coolify", "crafty", "generic-json"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

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

export interface IntegrationKindInfo {
  kind: IntegrationKind;
  label: string;
  description: string;
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  fields: IntegrationField[];
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
  appId: string | null;
  /** When true every signed-in person may use it in their widgets; otherwise only admins. */
  shared: boolean;
  /** Non-secret settings. For generic-json, `headers` values are replaced by "" (names kept). */
  config: Record<string, unknown>;
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
  links: { home: string | null; away: string | null };
  appId: string | null;
  appLine: LineState | null;
}

/** Always 200; `ok` says whether it worked. */
export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  detail: string | null;
  version: string | null;
  serverName: string | null;
  /** Choices discovered while testing, for follow-up fields (e.g. Jellyfin users for `userId`). */
  options: { users?: { id: string; name: string }[] } | null;
  /** Generic JSON only: the evaluated fields, so the form can preview them. */
  preview: JsonFieldValue[] | null;
  ms: number;
}

export interface IntegrationSuggestion {
  /** Stable key: `${kind}:${appId}:${port}`. */
  key: string;
  kind: IntegrationKind;
  name: string;
  appId: string;
  appName: string;
  icon: string | null;
  baseUrl: string;
  keyHelp: string;
  note: string | null;
  running: boolean;
  alreadyAdded: boolean;
  config: Record<string, unknown>;
}

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
  "crafty.servers",
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
  "crafty.servers": "crafty",
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
  "crafty.servers": 10_000,
  "json.fields": 30_000,
  weather: 900_000,
  calendar: 900_000,
  feed: 900_000,
  "link.status": 60_000,
};

// Integration widgets send `{ type, integration: "<id>", config }`; personal widgets send `{ type, config }`.
// The zod schemas are in widgets-schemas.ts, kept apart so client bundles carry no zod.

export const HA_ENTITY_ID = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,190}$/;
export const HA_MAX_PICKED = 60;

/** Personal sources (weather, calendar, feed, link status) should use POST so URLs stay out of logs and history. */
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
  key: string;
  kind: IntegrationKind;
  label: string;
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
  account: string;
}

export interface WidgetCatalog {
  apps: InstalledApp[];
  types: {
    type: WidgetType;
    label: string;
    description: string;
    source: IntegrationKind | null;
    refreshMs: number;
    integrations: IntegrationRef[];
    /** false when an integration is needed and none is available to this person. */
    available: boolean;
  }[];
  local: LocalWidgetAvailability[];
}

export interface GeocodeResult {
  results: {
    id: number;
    name: string;
    region: string | null;
    country: string | null;
    countryCode: string | null;
    lat: number;
    lon: number;
    timezone: string | null;
  }[];
}

export type MediaKind = "movie" | "series" | "episode" | "album" | "track" | "video" | "other";

export interface NowPlayingSession {
  id: string;
  user: string | null;
  client: string | null;
  device: string | null;
  item: {
    id: string;
    kind: MediaKind;
    title: string;
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
  subtitle: string | null;
  year: number | null;
  addedAt: number | null;
  image: string | null;
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
  note?: string | null;
}

export interface ImmichStatsData {
  /** "server" = everyone's library (admin key); "user" = only the key owner's library. */
  scope: "server" | "user";
  photos: number;
  videos: number;
  /** null in "user" scope (Immich doesn't report it per user without admin). */
  usageBytes: number | null;
  users: { id: string; name: string; photos: number; videos: number; usageBytes: number; quotaBytes: number | null }[];
  memories: ImmichMemory[] | null;
  memoriesNote: string | null;
}

export interface ImmichRecentData {
  items: { id: string; kind: "image" | "video"; image: string; takenAt: number | null }[];
  note: string | null;
}

/** "On this day": photos taken on today's date in earlier years, one year per entry, newest year first. */
export interface ImmichOnThisDayData {
  years: {
    id: string;
    year: number;
    yearsAgo: number;
    photos: { id: string; kind: "image" | "video"; image: string; takenAt: number | null }[];
  }[];
  note: string | null;
}

export interface ImmichMemory {
  id: string;
  title: string;
  year: number | null;
  assets: { id: string; kind: "image" | "video"; image: string }[];
}

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

export interface SlskdTransfer {
  id: string;
  direction: "download" | "upload";
  user: string;
  file: string;
  folder: string | null;
  sizeBytes: number;
  transferredBytes: number;
  /** 0…100 */
  percent: number;
  speedBps: number | null;
  state: "active" | "queued" | "done" | "failed";
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
  id: string;
  name: string;
  room: string | null;
  kind: AccessoryKind;
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
  target: number | null;
  detail: string | null;
  /** Lit, open, running, playing, motion seen: drawn as an active tile. */
  active: boolean;
  unavailable: boolean;
  control: HaControl | null;
  /** For toggle and cover controls: whether it's on / open right now. */
  on: boolean | null;
  shared: boolean;
  /** An admin let household members press it (never for locks, alarms, garage doors, gates or doors). Admins always can. */
  household: boolean;
  changedAt: number | null;
  lastUsedAt: number | null;
}

export interface HomeAssistantEntitiesData {
  location: string | null;
  /** The picked entities that still exist, in the picked order. */
  entities: HomeAssistantEntity[];
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

export interface HomeAssistantPickable {
  id: string;
  name: string;
  domain: string;
  area: string | null;
  icon: HaIcon;
  control: HaControl | null;
  shared: boolean;
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

export const HA_ACTIONS = ["turn_on", "turn_off", "open", "close", "run", "press"] as const;
export type HaAction = (typeof HA_ACTIONS)[number];

export interface HomeAssistantControlResult {
  /** The entity as Home Assistant reports it after the change (null if it couldn't say). */
  entity: HomeAssistantEntity | null;
}

export interface HouseholdControlsBody {
  see?: { allow: string[]; deny: string[] };
  press?: { allow: string[]; deny: string[] };
}

export interface ShowPlacesBody {
  show: boolean;
}

export type CoolifyDeploymentStatus = "queued" | "in_progress" | "finished" | "failed" | "cancelled";

export interface CoolifyDeployment {
  id: string;
  app: string;
  status: CoolifyDeploymentStatus;
  commit: string | null;
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
    problems: CoolifyResource[];
  };
  /** Why the history is missing (an older Coolify, a token without read access), else null. */
  historyNote: string | null;
}

/**
 * What a Crafty server is doing, from its latest stats. "starting" means the process is up but the game isn't
 * answering yet; "unresponsive" means it has been up a while and still doesn't answer; "waiting" is Crafty's own
 * delayed autostart.
 */
export type CraftyServerState = "running" | "starting" | "stopped" | "crashed" | "updating" | "importing" | "waiting" | "unresponsive" | "unknown";

export const CRAFTY_ACTIONS = ["start", "stop", "restart", "kill"] as const;
export type CraftyAction = (typeof CRAFTY_ACTIONS)[number];

export interface CraftyServer {
  id: string;
  name: string;
  game: string;
  state: CraftyServerState;
  line: LineState;
  /** The game process is up (Crafty's `running`), whether or not it answers yet. */
  running: boolean;
  /** Players, when the server answered Crafty's last check. `names` is the sample the game shares (up to 12). */
  players: { online: number; max: number; names: string[] } | null;
  /** From the server's own answer, or the last one Gluon saw while it ran. */
  version: string | null;
  startedAt: number | null;
  /** Opaque marker of the current run: changes when the server restarts. */
  run: string | null;
  /** Process CPU (% of one core) and memory (bytes), while running. */
  cpu: number | null;
  memory: number | null;
  port: number | null;
  stopTimeoutMs: number;
}

export interface CraftyServersData {
  version: string | null;
  servers: CraftyServer[];
}

/** POST /api/integrations/[id]/crafty (admin) body. `kill` also needs a recent sign-in. */
export interface CraftyActionBody {
  server: string;
  action: CraftyAction;
}

/**
 * POST answers with the server as Crafty reports it right after the command (null if Crafty took the command but
 * didn't answer the follow-up read); GET ?server=<id> polls it.
 */
export interface CraftyServerResult {
  server: CraftyServer | null;
}

export const JSON_FIELD_FORMATS = ["text", "number", "bytes", "percent", "duration", "date", "relative", "boolean"] as const;
export type JsonFieldFormat = (typeof JSON_FIELD_FORMATS)[number];

export interface JsonFieldValue {
  label: string;
  format: JsonFieldFormat;
  /** Raw value found at the path (arrays become their length), or null if nothing was there. */
  value: string | number | boolean | null;
  /** Formatted with default settings, for quick display. Re-format `value` with prefs if you like. */
  display: string;
  missing: boolean;
}

export interface JsonFieldsData {
  fields: JsonFieldValue[];
}

export type WeatherIcon = "clear" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "freezing-rain" | "snow" | "showers" | "snow-showers" | "thunder";

export interface WeatherData {
  place: string | null;
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
  endDate: string | null;
  location: string | null;
  recurring: boolean;
  ongoing: boolean;
}

export interface CalendarData {
  name: string | null;
  events: CalendarEvent[];
  timezone: string;
}

export interface FeedItem {
  id: string;
  title: string;
  url: string | null;
  publishedAt: number | null;
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

export interface LinkStatusData {
  url: string;
  up: boolean;
  status: number | null;
  latencyMs: number | null;
  message: string;
  checkedAt: number;
}

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
  "crafty.servers": CraftyServersData;
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
  "crafty.servers": { label: "Minecraft servers", description: "Every server in Crafty Controller: who's playing, and start, stop or restart." },
  "json.fields": { label: "Custom values", description: "Numbers pulled from any JSON address." },
  weather: { label: "Weather", description: "Current weather and the next hours for a place." },
  calendar: { label: "Calendar", description: "Upcoming events from a calendar link (ICS)." },
  feed: { label: "News feed", description: "Latest posts from an RSS or Atom feed." },
  "link.status": { label: "Link status", description: "Whether a web address is answering." },
};
