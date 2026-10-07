"use client";
import * as React from "react";
import {
  Activity,
  Album,
  AlbumList,
  AppWindow,
  Archive,
  Bell,
  BoxIso,
  ClockRotateRight,
  Clock,
  Cube,
  Database,
  DownloadCircle,
  Erase,
  Droplet,
  EmptyPage,
  Flash,
  Folder,
  Garage,
  HalfMoon,
  HardDrive,
  Journal,
  LightBulb,
  Lock,
  LogOut,
  MapPin,
  MediaImage,
  MediaVideo,
  MediaVideoList,
  Microphone,
  Movie,
  MusicDoubleNote,
  MusicNote,
  Network,
  OpenNewWindow,
  Page,
  Play,
  PlugTypeA,
  RefreshDouble,
  Restart,
  Search,
  Server,
  Square,
  SunLight,
  TemperatureHigh,
  Text,
  Tv,
  User,
  Walking,
  WarningTriangle,
  Wind,
  WindowLock,
  Wrench,
} from "iconoir-react";
import { AppIcon } from "@/components/apps/AppIcon";
import { NavIcon } from "./NavIcon";
import s from "./palette.module.css";

type Icon = React.ComponentType<{ strokeWidth?: number }>;

/** Icons for result types that aren't sidebar sections. Anything else falls back to the sidebar's set. */
const TYPES: Record<string, Icon> = {
  // Gluon's own things
  container: Cube,
  "image-layers": BoxIso,
  storage: Database,
  network: Network,
  disk: HardDrive,
  monitor: Activity,
  bell: Bell,
  person: User,
  service: Server,
  history: ClockRotateRight,
  finding: WarningTriangle,
  fix: Wrench,
  recheck: RefreshDouble,
  open: OpenNewWindow,
  restart: Restart,
  stop: Square,
  start: Play,
  logs: Journal,
  recent: Clock,
  erase: Erase,
  light: SunLight,
  dark: HalfMoon,
  signout: LogOut,
  action: Flash,
  // Files
  "file-folder": Folder,
  "file-image": MediaImage,
  "file-video": MediaVideo,
  "file-audio": MusicNote,
  "file-document": Page,
  "file-archive": Archive,
  "file-text": Text,
  "file-disk-image": HardDrive,
  "file-other": EmptyPage,
  // Inside connected apps
  film: Movie,
  series: MediaVideoList,
  episode: MediaVideo,
  video: MediaVideo,
  collection: AlbumList,
  album: Album,
  song: MusicDoubleNote,
  artist: Microphone,
  photo: MediaImage,
  place: MapPin,
  outlet: PlugTypeA,
  switch: Flash,
  fan: Wind,
  air: Wind,
  thermostat: TemperatureHigh,
  temperature: TemperatureHigh,
  humidity: Droplet,
  contact: WindowLock,
  motion: Walking,
  lock: Lock,
  cover: Garage,
  tv: Tv,
  download: DownloadCircle,
  search: Search,
};

// "light" is both the theme switch and a Homebridge light; results from apps say so with `tier`.
const APP_TYPES: Record<string, Icon> = { light: LightBulb };

/** The 28px tile at the start of a result: an app's icon, a thumbnail, or a line icon. */
export const PaletteIcon = React.memo(function PaletteIcon({ icon, image, label, fromApp }: { icon?: string; image?: string | null; label: string; fromApp: boolean }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (icon === "app" || (icon?.startsWith("open") && image)) {
    return <AppIcon src={image ?? null} name={label} size={28} />;
  }
  if (image && broken !== image) {
    return (
      <span className={s.thumb} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" width={28} height={28} loading="lazy" decoding="async" onError={() => setBroken(image)} />
      </span>
    );
  }
  const I = (fromApp && icon ? APP_TYPES[icon] : undefined) ?? (icon ? TYPES[icon] : undefined);
  return (
    <span className={s.optIcon} aria-hidden>
      {I ? <I strokeWidth={1.6} /> : icon ? <NavIcon id={icon} /> : <AppWindow strokeWidth={1.6} />}
    </span>
  );
});
