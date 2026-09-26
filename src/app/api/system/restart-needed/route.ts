import { z } from "zod";
import { route } from "@/server/api";
import { restartNeeded } from "@/server/system/apt";

/** Reboot required + services still running old libraries after updates. */
export const GET = route({ auth: "admin", query: z.object({ fresh: z.enum(["0", "1"]).optional() }) }, ({ query }) => restartNeeded({ fresh: query.fresh === "1" }));
