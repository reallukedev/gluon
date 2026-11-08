import { z } from "zod";
import { route } from "@/server/api";
import { diskOverview } from "@/server/dockerx/disk";

export const GET = route({ auth: "admin", query: z.object({ fresh: z.string().optional() }) }, ({ query }) => diskOverview(query.fresh === "1"));
