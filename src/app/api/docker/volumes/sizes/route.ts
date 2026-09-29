import { z } from "zod";
import { route } from "@/server/api";
import { volumeSizes } from "@/server/dockerx/volumes";

/** How much each volume holds. Docker walks every file for this, so it's asked for separately. */
export const GET = route({ auth: "admin", query: z.object({ fresh: z.string().optional() }) }, ({ query }) => volumeSizes(query.fresh === "1"));
