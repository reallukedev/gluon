"use client";
import * as React from "react";
import type { WidgetDef } from "./types";
import {
  ClockWidget,
  ClockSettings,
  StatusWidget,
  VitalsWidget,
  StorageWidget,
  SpectrumWidget,
  BookmarksWidget,
  BookmarksSettings,
  NotesWidget,
  NotesSettings,
  type ClockConfig,
  type BookmarksConfig,
  type NotesConfig,
} from "./widgets/core";
import { NetworkWidget } from "./widgets/network";
import { AppSettings, type AppConfig } from "./widgets/app";
import { AppCardPreview, AppCardWidget } from "./AppCard";
import { ALL_APPS } from "@/lib/home";
import { Preview } from "./previews";
import { extraWidgets } from "./widgetStore";
import "./widgets/start";
import "./widgets/integrations";
import "./widgets/household";
import "./widgets/machine";
import "./widgets/machine-logins";
import "./widgets/server-watch";

const def = <C,>(d: WidgetDef<C>) => d as unknown as WidgetDef;

export const WIDGETS: WidgetDef[] = [
  def<ClockConfig>({
    type: "clock",
    name: "Clock",
    description: "The time and date, plus other time zones if you like.",
    category: "For you",
    sizes: ["s", "m", "t"],
    defaultSize: "s",
    defaultConfig: {},
    Component: ClockWidget,
    Settings: ClockSettings,
    preview: <Preview of="clock" />,
  }),
  def<BookmarksConfig>({
    type: "bookmarks",
    name: "Links",
    description: "The sites and pages you open every day.",
    category: "For you",
    sizes: ["s", "m", "t", "l", "w"],
    defaultSize: "m",
    defaultConfig: { links: [] },
    multiple: true,
    setupOnPin: true,
    keywords: "bookmarks sites",
    title: (c) => c.title || "Links",
    Component: BookmarksWidget,
    Settings: BookmarksSettings,
    preview: <Preview of="links" />,
  }),
  def<NotesConfig>({
    type: "notes",
    name: "Notes",
    description: "A scratchpad that saves as you type. Only you can see it.",
    category: "For you",
    sizes: ["s", "m", "t", "l"],
    defaultSize: "s",
    defaultConfig: { text: "" },
    multiple: true,
    keywords: "note scratchpad memo text",
    title: (c) => c.title || "Notes",
    Component: NotesWidget,
    Settings: NotesSettings,
    preview: <Preview of="notes" />,
  }),
  def<AppConfig>({
    type: "app",
    name: "App",
    description: "One app on its own card: open it in a tap, see whether it's running, and in bigger sizes what it's doing.",
    category: "Apps",
    sizes: ["i", "c", "s", "m"],
    defaultSize: "i",
    sizeLabels: { i: "Icon", c: "Row", s: "Card", m: "Wide" },
    defaultConfig: {},
    perApp: true,
    multiple: true,
    label: (c) => (c.name || c.appId ? `${c.name ?? c.appId}` : null),
    Component: AppCardWidget,
    Settings: AppSettings,
    preview: <AppCardPreview />,
  }),
  // Default layouts use this as "every app this person can open, as cards, here"; the server expands it, so it
  // never renders. Registered only so admin screens that list a layout can name it.
  def({
    type: ALL_APPS,
    name: "Your apps",
    description: "Every app the person can open, one card each.",
    category: "Apps",
    sizes: ["i"],
    defaultSize: "i",
    defaultConfig: {},
    hidden: true,
    Component: () => null,
    preview: <Preview of="apps" />,
  }),
  def({
    type: "status",
    name: "Is everything working?",
    description: "One sentence about the server, and anything that needs attention.",
    category: "Server",
    sizes: ["s", "m", "t", "l", "w"],
    defaultSize: "m",
    defaultConfig: {},
    Component: StatusWidget,
    preview: <Preview of="status" />,
  }),
  def({
    type: "spectrum",
    name: "Everything running",
    description: "Every app and disk on the server as a line. Hover to see what it's doing.",
    category: "Server",
    sizes: ["w", "x"],
    defaultSize: "w",
    defaultConfig: {},
    adminOnly: true,
    title: () => "Everything on this server",
    Component: SpectrumWidget,
    preview: <Preview of="spectrum" />,
  }),
  def({
    type: "vitals",
    name: "Processor & memory",
    description: "Live CPU and memory, with temperature and network in bigger sizes.",
    category: "Server",
    sizes: ["s", "m", "t", "w"],
    defaultSize: "s",
    defaultConfig: {},
    title: () => "This machine",
    Component: VitalsWidget,
    preview: <Preview of="vitals" />,
  }),
  def({
    type: "network",
    name: "Network traffic",
    description: "What's coming in and going out over the last few minutes. Hover to read any moment.",
    category: "Server",
    sizes: ["s", "m", "t", "l", "w"],
    defaultSize: "m",
    defaultConfig: {},
    title: () => "Network",
    Component: NetworkWidget,
    preview: <Preview of="network" />,
  }),
  def({
    type: "storage",
    name: "Storage",
    description: "How full each disk is.",
    category: "Server",
    sizes: ["s", "m", "t", "l"],
    defaultSize: "t",
    defaultConfig: {},
    adminOnly: true,
    title: () => "Storage",
    Component: StorageWidget,
    preview: <Preview of="storage" />,
  }),
];

export { registerWidget } from "./widgetStore";

// Home looks definitions up for every item on every render: build the list and a by-type index once (again only if
// something registers later).
let index: { count: number; list: WidgetDef[]; byType: Map<string, WidgetDef> } | null = null;
function widgetIndex() {
  if (!index || index.count !== extraWidgets.length) {
    const list = [...WIDGETS, ...extraWidgets];
    const byType = new Map<string, WidgetDef>();
    for (const w of list) if (!byType.has(w.type)) byType.set(w.type, w);
    index = { count: extraWidgets.length, list, byType };
  }
  return index;
}

export function allWidgets(): readonly WidgetDef[] {
  return widgetIndex().list;
}

export function widgetDef(type: string): WidgetDef | undefined {
  return widgetIndex().byType.get(type);
}
