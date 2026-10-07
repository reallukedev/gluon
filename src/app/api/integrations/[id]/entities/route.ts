import { route } from "@/server/api";
import { badRequest } from "@/server/errors";
import { contextFor, readableRecord } from "@/server/integrations/store";
import { pickable, sharedOf } from "@/server/integrations/kinds/homeassistant";
import type { HomeAssistantPickableList } from "@/lib/widgets-types";

/**
 * What a Home Assistant widget can show, for its settings: names, rooms and whether household members may see and
 * use each one. No states and no attributes. Admins get everything; household members only what an admin shared
 * with the household, so the rest of the house's inventory never reaches them.
 */
export const GET = route({ auth: "user", burst: { limit: 30, windowMs: 60_000 } }, async ({ user, params }): Promise<HomeAssistantPickableList> => {
  const rec = readableRecord(user, String(Array.isArray(params.id) ? params.id[0] : params.id));
  if (rec.kind !== "homeassistant") throw badRequest("That connected app isn't Home Assistant.");
  if (user.role === "admin") return pickable(contextFor(rec));
  return pickable(contextFor(rec), new Set(sharedOf(rec.config)));
});
