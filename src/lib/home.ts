import { z } from "zod";

/** Widget sizes, iOS-style presets on a 12-column grid (columns × rows of ~88 px). */
export const SIZES = {
  s: { cols: 3, rows: 2, label: "Small" },
  m: { cols: 6, rows: 2, label: "Wide" },
  t: { cols: 3, rows: 4, label: "Tall" },
  l: { cols: 6, rows: 4, label: "Large" },
  w: { cols: 12, rows: 2, label: "Full width" },
  x: { cols: 12, rows: 4, label: "Full width, tall" },
} as const;
export type Size = keyof typeof SIZES;

export const widgetItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/),
  type: z.string().regex(/^[a-z][a-z0-9.-]{1,40}$/),
  size: z.enum(["s", "m", "t", "l", "w", "x"]),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type WidgetItem = z.infer<typeof widgetItemSchema>;

export const layoutSchema = z.object({
  version: z.literal(1).default(1),
  items: z.array(widgetItemSchema).max(40),
});
export type HomeLayout = z.infer<typeof layoutSchema>;

let n = 0;
export const widgetId = () => `w${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const ADMIN_DEFAULT: HomeLayout = {
  version: 1,
  items: [
    { id: "wstatus", type: "status", size: "m", config: {} },
    { id: "wvitals", type: "vitals", size: "s", config: {} },
    { id: "wclock", type: "clock", size: "s", config: {} },
    { id: "wspectrum", type: "spectrum", size: "w", config: {} },
    { id: "wapps", type: "apps", size: "l", config: { show: "all" } },
    { id: "wstorage", type: "storage", size: "t", config: {} },
    { id: "wnetwork", type: "network", size: "t", config: {} },
    { id: "wbookmarks", type: "bookmarks", size: "m", config: { links: [] } },
    { id: "wnotes", type: "notes", size: "m", config: { text: "" } },
  ],
};

export const HOUSEHOLD_DEFAULT: HomeLayout = {
  version: 1,
  items: [
    { id: "wclock", type: "clock", size: "m", config: {} },
    { id: "wstatus", type: "status", size: "m", config: {} },
    { id: "wapps", type: "apps", size: "l", config: { show: "all" } },
    { id: "wbookmarks", type: "bookmarks", size: "t", config: { links: [] } },
    { id: "wnotes", type: "notes", size: "t", config: { text: "" } },
  ],
};
