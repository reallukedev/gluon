"use client";
// Integration widgets (media, downloads, home accessories, weather, calendar, feeds…), registered with the
// widget store. Each reads its data through one batched POST to /api/widgets/data.
import { registerWidget } from "../widgetStore";
import {
  ImmichRecent,
  ImmichRecentSettings,
  ImmichSettings,
  ImmichStats,
  IntegrationSettingsFor,
  JellyfinLibraries,
  JellyfinNowPlaying,
  JellyfinRecent,
  JellyfinRecentSettings,
  SubsonicNowPlaying,
  SubsonicRecent,
  type ImmichConfig,
  type ImmichRecentConfig,
  type IntegrationConfig,
  type RecentConfig,
} from "./live/media";
import { HomebridgeAccessories, HomebridgeSettings, JsonFields, LinkStatus, LinkStatusSettings, SlskdTransfers, type HomebridgeConfig, type LinkStatusConfig } from "./live/services";
import { CalendarSettings, CalendarWidget, FeedSettings, FeedWidget, WeatherSettings, WeatherWidget, type CalendarConfig, type FeedConfig, type WeatherConfig } from "./live/personal";
import p from "./live/live.module.css";

/* Catalog previews: abstract drawings in the product's line language. */
const PvRow = ({ square }: { square?: boolean }) => (
  <span className={p.pvRow}>
    <i className={square ? p.pvSquare : p.pvPoster} />
    <span className={p.pvLines}>
      <i />
      <i />
      <i className={p.pvProgress} />
    </span>
  </span>
);
const PvShelf = ({ square }: { square?: boolean }) => (
  <span className={p.pvShelf}>
    {[0, 1, 2, 3, 4].map((i) => (
      <i key={i} className={square ? p.pvSquare : p.pvPoster} />
    ))}
  </span>
);
const PvStats = ({ values }: { values: string[] }) => (
  <span className={p.pvStats}>
    {values.map((v) => (
      <b key={v}>{v}</b>
    ))}
  </span>
);

registerWidget<IntegrationConfig>({
  type: "jellyfin.now-playing",
  kind: "jellyfin",
  name: "Now watching",
  description: "Who is watching what on Jellyfin, with progress.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || "Now watching",
  Component: JellyfinNowPlaying,
  Settings: IntegrationSettingsFor("jellyfin", "Now watching"),
  preview: <PvRow />,
});

registerWidget<RecentConfig>({
  type: "jellyfin.recent",
  kind: "jellyfin",
  name: "New on Jellyfin",
  description: "Posters of recently added movies and episodes (and albums if you like).",
  category: "Media & services",
  sizes: ["m", "l", "w", "x"],
  defaultSize: "w",
  defaultConfig: { include: ["movie", "episode"] },
  title: (c) => c.title || "New on Jellyfin",
  Component: JellyfinRecent,
  Settings: JellyfinRecentSettings,
  preview: <PvShelf />,
});

registerWidget<IntegrationConfig>({
  type: "jellyfin.libraries",
  kind: "jellyfin",
  name: "Jellyfin libraries",
  description: "How many movies, shows and albums you have.",
  category: "Media & services",
  sizes: ["s", "m", "t"],
  defaultSize: "s",
  defaultConfig: {},
  title: (c) => c.title || "Libraries",
  Component: JellyfinLibraries,
  Settings: IntegrationSettingsFor("jellyfin", "Libraries"),
  preview: <PvStats values={["412", "86"]} />,
});

registerWidget<ImmichConfig>({
  type: "immich.stats",
  kind: "immich",
  name: "Photos",
  description: "Photo and video counts from Immich, space per person, and memories in the large sizes.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: { memories: true },
  title: (c) => c.title || "Photos",
  Component: ImmichStats,
  Settings: ImmichSettings,
  preview: (
    <span className={p.pvGrid}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} />
      ))}
    </span>
  ),
});

registerWidget<ImmichRecentConfig>({
  type: "immich.recent",
  kind: "immich",
  name: "Latest photos",
  description: "The newest photos and videos in Immich, as a wall that fills the widget.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w", "x"],
  defaultSize: "w",
  defaultConfig: { show: "all" },
  title: (c) => c.title || "Latest photos",
  Component: ImmichRecent,
  Settings: ImmichRecentSettings,
  preview: (
    <span className={p.pvGrid}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} />
      ))}
    </span>
  ),
});

registerWidget<IntegrationConfig>({
  type: "subsonic.now-playing",
  kind: "subsonic",
  name: "Now playing",
  description: "What people are listening to on Navidrome, Octo or another Subsonic server.",
  category: "Media & services",
  sizes: ["s", "m", "t"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || "Now playing",
  Component: SubsonicNowPlaying,
  Settings: IntegrationSettingsFor("subsonic", "Now playing"),
  preview: <PvRow square />,
});

registerWidget<IntegrationConfig>({
  type: "subsonic.recent",
  kind: "subsonic",
  name: "New music",
  description: "Album covers of what was added to your music library.",
  category: "Media & services",
  sizes: ["m", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || "New music",
  Component: SubsonicRecent,
  Settings: IntegrationSettingsFor("subsonic", "New music"),
  preview: <PvShelf square />,
});

registerWidget<IntegrationConfig>({
  type: "slskd.transfers",
  kind: "slskd",
  name: "Soulseek transfers",
  description: "Downloads and uploads in slskd, with progress, speed and time left.",
  category: "Media & services",
  sizes: ["m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || "Transfers",
  Component: SlskdTransfers,
  Settings: IntegrationSettingsFor("slskd", "Transfers"),
  preview: (
    <span className={p.pvBars}>
      <i style={{ width: "76%" }} />
      <i style={{ width: "38%" }} />
      <i style={{ width: "12%" }} data-dashed="" />
    </span>
  ),
});

registerWidget<HomebridgeConfig>({
  type: "homebridge.accessories",
  kind: "homebridge",
  name: "Home accessories",
  description: "Lights, plugs and sensors from Homebridge: on or off, temperatures, doors. Read-only.",
  category: "Media & services",
  sizes: ["m", "t", "l", "w"],
  defaultSize: "l",
  defaultConfig: {},
  title: (c) => c.title || "Home",
  Component: HomebridgeAccessories,
  Settings: HomebridgeSettings,
  preview: (
    <span className={p.pvTiles}>
      <i data-on="" />
      <i />
      <i />
      <i data-on="" />
    </span>
  ),
});

registerWidget<IntegrationConfig>({
  type: "json.fields",
  kind: "generic-json",
  name: "Custom values",
  description: "Numbers pulled from any JSON address your admin set up, like uptime or counts.",
  category: "Media & services",
  sizes: ["s", "m", "t", "w"],
  defaultSize: "s",
  defaultConfig: {},
  title: (c) => c.title || "Values",
  Component: JsonFields,
  Settings: IntegrationSettingsFor("generic-json", "Values"),
  preview: <PvStats values={["42", "7d"]} />,
});

registerWidget<WeatherConfig>({
  type: "weather",
  name: "Weather",
  description: "Now, today's high and low, and the next hours for a place you pick.",
  category: "For you",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || c.name || "Weather",
  Component: WeatherWidget,
  Settings: WeatherSettings,
  preview: (
    <span className={p.pvWeather}>
      <b>18°</b>
      <svg viewBox="0 0 60 20" aria-hidden>
        <polyline points="0,14 10,12 20,8 30,6 40,9 50,13 60,15" />
      </svg>
    </span>
  ),
});

registerWidget<CalendarConfig>({
  type: "calendar",
  name: "Calendar",
  description: "Your next events from a calendar link, grouped by day.",
  category: "For you",
  sizes: ["m", "t", "l"],
  defaultSize: "t",
  defaultConfig: { days: 7 },
  title: (c) => c.title || c.calName || "Calendar",
  Component: CalendarWidget,
  Settings: CalendarSettings,
  preview: (
    <span className={p.pvAgenda}>
      <i className={p.pvDay} />
      {[0, 1, 2].map((i) => (
        <span key={i}>
          <i />
          <i />
        </span>
      ))}
    </span>
  ),
});

registerWidget<FeedConfig>({
  type: "feed",
  name: "News feed",
  description: "The latest posts from a blog or news site (RSS or Atom).",
  category: "For you",
  sizes: ["m", "t", "l", "w"],
  defaultSize: "t",
  defaultConfig: {},
  title: (c) => c.title || c.feedTitle || "News",
  Component: FeedWidget,
  Settings: FeedSettings,
  preview: (
    <span className={p.pvFeed}>
      {[0, 1, 2].map((i) => (
        <span key={i}>
          <i />
          <i />
        </span>
      ))}
    </span>
  ),
});

registerWidget<LinkStatusConfig>({
  type: "link.status",
  name: "Is it up?",
  description: "Whether a web address answers, and how quickly. Works for things on your home network too.",
  category: "For you",
  sizes: ["s", "m"],
  defaultSize: "s",
  defaultConfig: {},
  Component: LinkStatus,
  Settings: LinkStatusSettings,
  preview: (
    <span className={p.pvStatus}>
      <i />
      <b>42 ms</b>
    </span>
  ),
});

export {};
