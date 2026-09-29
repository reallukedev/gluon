import { z } from "zod";
import { route } from "@/server/api";
import { diskOverview } from "@/server/dockerx/disk";

/** What Docker keeps on disk, by kind, and what could go. */
export const GET = route({ auth: "admin", query: z.object({ fresh: z.string().optional() }) }, ({ query }) => diskOverview(query.fresh === "1"));
