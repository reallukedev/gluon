import { z } from "zod";

/**
 * Widget sizes, iOS-style presets on a 12-column grid (columns × rows of ~86 px). The short ones (one row) are for
 * things that are a line, not a panel: the greeting, the search bar, a folder or link shortcut.
 */
export const SIZES = {
  i: { cols: 2, rows: 2, label: "Icon" },
  c: { cols: 3, rows: 1, label: "Small, short" },
  s: { cols: 3, rows: 2, label: "Small" },
  h: { cols: 6, rows: 1, label: "Wide, short" },
  m: { cols: 6, rows: 2, label: "Wide" },
  t: { cols: 3, rows: 4, label: "Tall" },
  l: { cols: 6, rows: 4, label: "Large" },
  b: { cols: 12, rows: 1, label: "Full width, short" },
  w: { cols: 12, rows: 2, label: "Full width" },
  x: { cols: 12, rows: 4, label: "Full width, tall" },
} as const;
export type Size = keyof typeof SIZES;
const SIZE_KEYS = Object.keys(SIZES) as [Size, ...Size[]];

export const widgetItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/),
  type: z.string().regex(/^[a-z][a-z0-9.-]{1,40}$/),
  size: z.enum(SIZE_KEYS),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type WidgetItem = z.infer<typeof widgetItemSchema>;

export const layoutSchema = z.object({
  version: z.literal(1).default(1),
  items: z.array(widgetItemSchema).max(80, "That's more than a home page can hold. Unpin a few things first."),
  /**
   * One-time changes already applied to this layout (so an item the person later unpins isn't put back).
   * "start": the greeting and the search bar became pinnable items instead of a fixed header.
   * "app-cards": pinned apps became one card each on the grid, replacing the single Apps block.
   */
  migrated: z.array(z.string().max(40)).max(20).optional(),
});
export type HomeLayout = z.infer<typeof layoutSchema>;

let n = 0;
export const widgetId = () => `w${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Pinned apps are `app` items, one per app. An item's id is derived from the app, so the same app always gets the
 * same id (defaults expanded on every read stay stable, and a pin is found by its app).
 */
export const appItemId = (appId: string) => `ap-${appId.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 40);
export const appItem = (app: { id: string; name: string }, size: Size = "i"): WidgetItem => ({ id: appItemId(app.id), type: "app", size, config: { appId: app.id, name: app.name } });
export const isAppItem = (i: WidgetItem, appId?: string) => i.type === "app" && (appId === undefined || i.config.appId === appId);
/** Placeholder in default layouts: "every app this person can open, as cards, here". Expanded on the server. */
export const ALL_APPS = "apps";

/** Items that open a Home page: new pins go in after them, not above the greeting. */
export const START_TYPES = new Set(["greeting", "search"]);

/** Where a newly pinned item goes: just after the greeting and search bar at the top. */
export function insertIndex(items: WidgetItem[]): number {
  let i = 0;
  while (i < items.length && START_TYPES.has(items[i]!.type)) i++;
  return i;
}

/** Where a newly pinned app goes: after the app cards already there, so apps stay together; else at the top. */
export function appInsertIndex(items: WidgetItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "app") return i + 1;
  return insertIndex(items);
}

/** The greeting and search bar that used to be a fixed header, for layouts made before they could be unpinned. */
export function withStart(layout: HomeLayout): HomeLayout {
  if (layout.migrated?.includes("start")) return layout;
  const has = (t: string) => layout.items.some((i) => i.type === t);
  const lead: WidgetItem[] = [
    ...(has("greeting") ? [] : [{ id: widgetId(), type: "greeting", size: "h" as const, config: {} }]),
    ...(has("search") ? [] : [{ id: widgetId(), type: "search", size: "h" as const, config: {} }]),
  ];
  return { ...layout, items: [...lead, ...layout.items].slice(0, 80), migrated: [...(layout.migrated ?? []), "start"] };
}

export const ADMIN_DEFAULT: HomeLayout = {
  version: 1,
  migrated: ["start"],
  items: [
    { id: "wgreeting", type: "greeting", size: "h", config: {} },
    { id: "wsearch", type: "search", size: "h", config: {} },
    { id: "wapps", type: ALL_APPS, size: "i", config: {} },
    { id: "wstatus", type: "status", size: "m", config: {} },
    { id: "wvitals", type: "vitals", size: "s", config: {} },
    { id: "wclock", type: "clock", size: "s", config: {} },
    { id: "wstorage", type: "storage", size: "t", config: {} },
    { id: "wnetwork", type: "network", size: "t", config: {} },
    { id: "winternet", type: "household.internet", size: "m", config: {} },
    { id: "wspace", type: "server.space", size: "m", config: {} },
    { id: "wuptime", type: "server.uptime", size: "w", config: {} },
    { id: "wbusy", type: "server.busy", size: "m", config: { by: "memory" } },
    { id: "wnotes", type: "notes", size: "m", config: { text: "" } },
  ],
};

export const HOUSEHOLD_DEFAULT: HomeLayout = {
  version: 1,
  migrated: ["start"],
  items: [
    { id: "wgreeting", type: "greeting", size: "h", config: {} },
    { id: "wsearch", type: "search", size: "h", config: {} },
    { id: "wapps", type: ALL_APPS, size: "i", config: {} },
    { id: "wclock", type: "clock", size: "m", config: {} },
    { id: "wstatus", type: "status", size: "m", config: {} },
    { id: "winternet", type: "household.internet", size: "m", config: {} },
    { id: "wnotes", type: "notes", size: "m", config: { text: "" } },
  ],
};
