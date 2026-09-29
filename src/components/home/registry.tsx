"use client";
import * as React from "react";
import type { WidgetDef } from "./types";
import {
  ClockWidget,
  ClockSettings,
  StatusWidget,
  AppsWidget,
  AppsSettings,
  VitalsWidget,
  StorageWidget,
  SpectrumWidget,
  BookmarksWidget,
  BookmarksSettings,
  NotesWidget,
  NotesSettings,
  type ClockConfig,
  type AppsConfig,
  type BookmarksConfig,
  type NotesConfig,
} from "./widgets/core";
import { NetworkWidget } from "./widgets/network";
import { AppWidget, AppSettings, AppPreview, type AppConfig } from "./widgets/app";
import p from "./preview.module.css";
import { extraWidgets } from "./widgetStore";
import "./widgets/integrations";
import "./widgets/machine-logins";
import "./widgets/server-watch";

/* Catalog previews: tiny abstract drawings in the product's own line language, not screenshots. */
const Lines = ({ pattern }: { pattern: string }) => (
  <span className={p.lines}>
    {pattern.split("").map((c, i) => (
      <i key={i} data-k={c} />
    ))}
  </span>
);

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
    preview: <span className={p.clock}>9:41</span>,
  }),
  def<BookmarksConfig>({
    type: "bookmarks",
    name: "Links",
    description: "The sites and pages you open every day.",
    category: "For you",
    sizes: ["s", "m", "t", "l", "w"],
    defaultSize: "m",
    defaultConfig: { links: [] },
    title: (c) => c.title || "Links",
    Component: BookmarksWidget,
    Settings: BookmarksSettings,
    preview: (
      <span className={p.rows}>
        <i />
        <i />
        <i />
      </span>
    ),
  }),
  def<NotesConfig>({
    type: "notes",
    name: "Notes",
    description: "A scratchpad that saves as you type. Only you can see it.",
    category: "For you",
    sizes: ["s", "m", "t", "l"],
    defaultSize: "s",
    defaultConfig: { text: "" },
    title: (c) => c.title || "Notes",
    Component: NotesWidget,
    Settings: NotesSettings,
    preview: <span className={p.ruled} />,
  }),
  def<AppsConfig>({
    type: "apps",
    name: "Apps",
    description: "Open your apps. Uses the home address at home and the public one when you're out.",
    category: "Apps",
    sizes: ["m", "t", "l", "w", "x"],
    defaultSize: "l",
    defaultConfig: { show: "all", style: "tiles" },
    title: () => "Apps",
    Component: AppsWidget,
    Settings: AppsSettings,
    preview: (
      <span className={p.tiles}>
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    ),
  }),
  def<AppConfig>({
    type: "app",
    name: "App",
    description: "One app at a glance: whether it's running, live CPU and memory, and a button to open it.",
    category: "Apps",
    sizes: ["s", "m", "t"],
    defaultSize: "s",
    defaultConfig: {},
    perApp: true,
    label: (c) => (c.name || c.appId ? `${c.name ?? c.appId} tile` : null),
    Component: AppWidget,
    Settings: AppSettings,
    preview: <AppPreview />,
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
    preview: <Lines pattern="||:|||=|" />,
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
    preview: <Lines pattern="|||:||.||=||||" />,
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
    preview: <span className={p.spark} />,
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
    preview: <span className={p.spark} data-two />,
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
    preview: (
      <span className={p.bars}>
        <i style={{ width: "82%" }} />
        <i style={{ width: "34%" }} />
        <i style={{ width: "58%" }} />
      </span>
    ),
  }),
];

export { registerWidget } from "./widgetStore";

export function allWidgets(): WidgetDef[] {
  return [...WIDGETS, ...extraWidgets];
}

export function widgetDef(type: string): WidgetDef | undefined {
  return allWidgets().find((w) => w.type === type);
}
