import { z } from "zod";
import { route } from "@/server/api";
import { cached } from "@/server/integrations/cache";
import { geocode } from "@/server/widgets/sources";

/** Place search for the weather widget (Open-Meteo geocoding). */
export const GET = route(
  { auth: "user", query: z.object({ q: z.string().trim().min(2, "Type at least two letters.").max(100) }) },
  async ({ query }) => {
    const term = query.q.toLowerCase();
    return (await cached(`geo:${term}`, 24 * 60 * 60_000, () => geocode(query.q))).value;
  },
);
