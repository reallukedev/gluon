import "server-only";
import { z } from "zod";
import { SIZES, type Size } from "./home";

/** The shape the server validates Home layouts with. Client code imports @/lib/home, which stays free of zod. */
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
