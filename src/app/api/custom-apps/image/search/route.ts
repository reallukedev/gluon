import { z } from "zod";
import { route } from "@/server/api";
import { searchHub } from "@/server/appstore/images";

/** Docker Hub repositories for what the person is typing. Cached; backs off when Docker Hub limits us. */
export const GET = route({ auth: "admin", query: z.object({ q: z.string().max(100) }), burst: { limit: 90, windowMs: 60_000 } }, ({ query }) => searchHub(query.q));
