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
import { HaEntities, HaEntitiesSettings, HaPeople, HaPeopleSettings, saveHaEntities, saveHaPeople, type HaEntitiesConfig, type HaPeopleConfig } from "./live/homeassistant";
import { CoolifyDeployments } from "./live/coolify";
import { ControlsPreview, DeploymentsPreview, PeoplePreview } from "./live/previews";
import { Preview } from "../previews";

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
  preview: <Preview of="now-playing" />,
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
  preview: <Preview of="shelf" />,
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
  preview: <Preview of="counts" />,
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
  preview: <Preview of="photos" />,
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
  preview: <Preview of="wall" />,
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
  preview: <Preview of="music-now" />,
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
  preview: <Preview of="music-shelf" />,
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
  preview: <Preview of="transfers" />,
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
  preview: <Preview of="accessories" />,
});

registerWidget<HaEntitiesConfig>({
  type: "homeassistant.entities",
  kind: "homeassistant",
  name: "Home controls",
  description: "Lights, switches, scenes and sensors you pick from Home Assistant. Press a tile to switch it.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w", "x"],
  defaultSize: "m",
  defaultConfig: {},
  multiple: true,
  setupOnPin: true,
  title: (c) => c.title || "Home",
  Component: HaEntities,
  Settings: HaEntitiesSettings,
  beforeSave: saveHaEntities,
  preview: <ControlsPreview />,
  keywords: "home assistant lights switches scenes sensors thermostat smart home",
});

registerWidget<HaPeopleConfig>({
  type: "homeassistant.people",
  kind: "homeassistant",
  name: "Who's home",
  description: "Who is home and who is out, and for how long, from the people in Home Assistant.",
  category: "Household",
  sizes: ["s", "m", "t", "w"],
  defaultSize: "s",
  defaultConfig: {},
  title: (c) => c.title || "Who's home",
  Component: HaPeople,
  Settings: HaPeopleSettings,
  beforeSave: saveHaPeople,
  preview: <PeoplePreview />,
  keywords: "home assistant people presence family away",
});

registerWidget<IntegrationConfig>({
  type: "coolify.deployments",
  kind: "coolify",
  name: "Deployments",
  description: "What Coolify is deploying, how the last deploys went, and anything that isn't running.",
  category: "Server",
  sizes: ["s", "m", "t", "l", "w", "x"],
  defaultSize: "m",
  defaultConfig: {},
  adminOnly: true,
  title: (c) => c.title || "Deployments",
  Component: CoolifyDeployments,
  Settings: IntegrationSettingsFor("coolify", "Deployments"),
  preview: <DeploymentsPreview />,
  keywords: "coolify deploy builds apps",
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
  preview: <Preview of="values" />,
});

registerWidget<WeatherConfig>({
  type: "weather",
  name: "Weather",
  description: "Now, today's high and low, and the next hours for a place you pick.",
  category: "For you",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  multiple: true,
  setupOnPin: true,
  defaultConfig: {},
  title: (c) => c.title || c.name || "Weather",
  Component: WeatherWidget,
  Settings: WeatherSettings,
  preview: <Preview of="weather" />,
});

registerWidget<CalendarConfig>({
  type: "calendar",
  name: "Calendar",
  description: "Your next events from a calendar link, grouped by day.",
  category: "For you",
  sizes: ["m", "t", "l"],
  defaultSize: "t",
  multiple: true,
  setupOnPin: true,
  defaultConfig: { days: 7 },
  title: (c) => c.title || c.calName || "Calendar",
  Component: CalendarWidget,
  Settings: CalendarSettings,
  preview: <Preview of="calendar" />,
});

registerWidget<FeedConfig>({
  type: "feed",
  name: "News feed",
  description: "The latest posts from a blog or news site (RSS or Atom).",
  category: "For you",
  sizes: ["m", "t", "l", "w"],
  defaultSize: "t",
  multiple: true,
  setupOnPin: true,
  defaultConfig: {},
  title: (c) => c.title || c.feedTitle || "News",
  Component: FeedWidget,
  Settings: FeedSettings,
  preview: <Preview of="feed" />,
});

registerWidget<LinkStatusConfig>({
  type: "link.status",
  name: "Is it up?",
  description: "Whether a web address answers, and how quickly. Works for things on your home network too.",
  category: "For you",
  sizes: ["s", "m"],
  defaultSize: "s",
  multiple: true,
  setupOnPin: true,
  defaultConfig: {},
  Component: LinkStatus,
  Settings: LinkStatusSettings,
  preview: <Preview of="link-status" />,
});

export {};
