"use client";
import dynamic from "next/dynamic";
import { registerWidget } from "../widgetStore";
import type { ImmichConfig, ImmichRecentConfig, IntegrationConfig, RecentConfig } from "./live/media";
import type { HomebridgeConfig, LinkStatusConfig } from "./live/services";
import type { CalendarConfig, FeedConfig, WeatherConfig } from "./live/personal";
import type { HaEntitiesConfig, HaPeopleConfig } from "./live/homeassistant";
import { ControlsPreview, DeploymentsPreview, PeoplePreview, ServersPreview } from "./live/previews";
import { Preview } from "../previews";
import type { IntegrationKind } from "@/lib/widgets-types";

// Only the widgets someone has on Home load their code: each arrives when it is first drawn.
const media = () => import("./live/media");
const services = () => import("./live/services");
const personal = () => import("./live/personal");
const homeassistant = () => import("./live/homeassistant");
const coolify = () => import("./live/coolify");
const crafty = () => import("./live/crafty");
const JellyfinNowPlaying = dynamic(() => media().then((x) => x.JellyfinNowPlaying));
const JellyfinRecent = dynamic(() => media().then((x) => x.JellyfinRecent));
const JellyfinRecentSettings = dynamic(() => media().then((x) => x.JellyfinRecentSettings));
const JellyfinLibraries = dynamic(() => media().then((x) => x.JellyfinLibraries));
const ImmichStats = dynamic(() => media().then((x) => x.ImmichStats));
const ImmichSettings = dynamic(() => media().then((x) => x.ImmichSettings));
const ImmichRecent = dynamic(() => media().then((x) => x.ImmichRecent));
const ImmichRecentSettings = dynamic(() => media().then((x) => x.ImmichRecentSettings));
const SubsonicNowPlaying = dynamic(() => media().then((x) => x.SubsonicNowPlaying));
const SubsonicRecent = dynamic(() => media().then((x) => x.SubsonicRecent));
const HomebridgeAccessories = dynamic(() => services().then((x) => x.HomebridgeAccessories));
const HomebridgeSettings = dynamic(() => services().then((x) => x.HomebridgeSettings));
const JsonFields = dynamic(() => services().then((x) => x.JsonFields));
const LinkStatus = dynamic(() => services().then((x) => x.LinkStatus));
const LinkStatusSettings = dynamic(() => services().then((x) => x.LinkStatusSettings));
const SlskdTransfers = dynamic(() => services().then((x) => x.SlskdTransfers));
const CalendarSettings = dynamic(() => personal().then((x) => x.CalendarSettings));
const CalendarWidget = dynamic(() => personal().then((x) => x.CalendarWidget));
const FeedSettings = dynamic(() => personal().then((x) => x.FeedSettings));
const FeedWidget = dynamic(() => personal().then((x) => x.FeedWidget));
const WeatherSettings = dynamic(() => personal().then((x) => x.WeatherSettings));
const WeatherWidget = dynamic(() => personal().then((x) => x.WeatherWidget));
const HaEntities = dynamic(() => homeassistant().then((x) => x.HaEntities));
const HaEntitiesSettings = dynamic(() => homeassistant().then((x) => x.HaEntitiesSettings));
const HaPeople = dynamic(() => homeassistant().then((x) => x.HaPeople));
const HaPeopleSettings = dynamic(() => homeassistant().then((x) => x.HaPeopleSettings));
const CoolifyDeployments = dynamic(() => coolify().then((x) => x.CoolifyDeployments));
const CraftyServers = dynamic(() => crafty().then((x) => x.CraftyServers));
const integrationSettings = (kind: IntegrationKind, placeholder: string) => dynamic(() => media().then((x) => x.IntegrationSettingsFor(kind, placeholder)));

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
  Settings: integrationSettings("jellyfin", "Now watching"),
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
  Settings: integrationSettings("jellyfin", "Libraries"),
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
  Settings: integrationSettings("subsonic", "Now playing"),
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
  Settings: integrationSettings("subsonic", "New music"),
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
  Settings: integrationSettings("slskd", "Transfers"),
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
  beforeSave: (c) => homeassistant().then((x) => x.saveHaEntities(c)),
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
  beforeSave: (c) => homeassistant().then((x) => x.saveHaPeople(c)),
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
  Settings: integrationSettings("coolify", "Deployments"),
  preview: <DeploymentsPreview />,
  keywords: "coolify deploy builds apps",
});

registerWidget<IntegrationConfig>({
  type: "crafty.servers",
  kind: "crafty",
  name: "Minecraft servers",
  description: "Your Crafty Controller servers: who's playing, and Start, Stop or Restart without opening Crafty.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w", "x"],
  defaultSize: "m",
  defaultConfig: {},
  title: (c) => c.title || "Minecraft servers",
  Component: CraftyServers,
  Settings: integrationSettings("crafty", "Minecraft servers"),
  preview: <ServersPreview />,
  keywords: "crafty controller minecraft game server players start stop restart",
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
  Settings: integrationSettings("generic-json", "Values"),
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
