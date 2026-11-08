import { z } from "zod";
import { route } from "@/server/api";
import { powerData } from "@/server/widgets/power";

/** `dayStart` is the viewer's local midnight, so "today" means their today. */
const query = z.object({ dayStart: z.coerce.number().int().min(0).optional() });

export const GET = route({ auth: "admin", query }, ({ query }) => {
  const t = Date.now();
  const fallback = t - (t % 86_400_000);
  const dayStart = query.dayStart && query.dayStart <= t && query.dayStart > t - 2 * 86_400_000 ? query.dayStart : fallback;
  return powerData(dayStart);
});
