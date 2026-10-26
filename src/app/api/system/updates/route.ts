import { z } from "zod";
import { route } from "@/server/api";
import { updatesStatus } from "@/server/system/updates";

/** Waiting updates, last check, locks, active run, reboot status. `?fresh=1` re-reads apt (no network). */
export const GET = route({ auth: "admin", query: z.object({ fresh: z.enum(["0", "1"]).optional() }) }, ({ query }) => updatesStatus({ fresh: query.fresh === "1" }));
