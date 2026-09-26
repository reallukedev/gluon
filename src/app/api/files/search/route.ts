import { z } from "zod";
import { route } from "@/server/api";
import { searchStream } from "@/server/files/search";
import { pathStr } from "../_schemas";

/** SSE: "hits" { items: SearchHit[] } batches, then "done" { count, truncated, timedOut }; "error" { message }. */
const query = z.object({
  path: pathStr,
  q: z.string().min(1, "Type something to search for.").max(200),
  depth: z.coerce.number().int().min(1).max(40).optional(),
  type: z.enum(["file", "dir", "any"]).optional(),
  modifiedWithinDays: z.coerce.number().min(0).max(36500).optional(),
  minSize: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const GET = route({ auth: "user", query }, ({ req, user, query }) => searchStream(req, user, query));
