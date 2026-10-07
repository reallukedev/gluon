import { z } from "zod";
import { route } from "@/server/api";
import { tagPage } from "@/server/appstore/images";

const query = z.object({
  ref: z.string().min(1).max(300),
  q: z.string().max(128).default(""),
  page: z.coerce.number().int().min(1).max(50).default(1),
});

/** One page of an image's tags (newest first, filtered by q). Doesn't need the image looked up first. */
export const GET = route({ auth: "admin", query, burst: { limit: 90, windowMs: 60_000 } }, ({ query }) => tagPage(query.ref, query.q, query.page));
