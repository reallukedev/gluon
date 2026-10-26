import { z } from "zod";
import { route } from "@/server/api";
import { listRuns } from "@/server/system/apt-runner";

const query = z.object({
  kind: z.enum(["refresh", "upgrade", "repair"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Past update runs, newest first (without logs). Default excludes the daily list refreshes. */
export const GET = route({ auth: "admin", query }, ({ query }) => ({ runs: listRuns(query) }));
