import { z } from "zod";
import { route } from "@/server/api";
import { exposureReport } from "@/server/network/exposure";

/** Exposure audit. `refresh=1` re-runs it and re-checks logins older than 10 minutes. */
export const GET = route({ auth: "admin", query: z.object({ refresh: z.enum(["0", "1"]).optional() }) }, ({ query }) =>
  exposureReport({ force: query.refresh === "1" }),
);
