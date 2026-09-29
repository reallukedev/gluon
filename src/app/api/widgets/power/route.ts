import { z } from "zod";
import { route } from "@/server/api";
import { powerData } from "@/server/widgets/power";

/**
 * The processor's power draw (RAPL): now, the last hour and day, energy since `dayStart` (the viewer's local
 * midnight, so "today" means their today) and the average for a monthly estimate. Admins.
 */
const query = z.object({ dayStart: z.coerce.number().int().min(0).optional() });

export const GET = route({ auth: "admin", query }, ({ query }) => {
  const t = Date.now();
  const fallback = t - (t % 86_400_000);
  const dayStart = query.dayStart && query.dayStart <= t && query.dayStart > t - 2 * 86_400_000 ? query.dayStart : fallback;
  return powerData(dayStart);
});
