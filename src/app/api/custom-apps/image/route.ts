import { z } from "zod";
import { route } from "@/server/api";
import { lookupImage } from "@/server/appstore/images";

/** Look an image up on this server and in its registry: exists? tags? ports, folders, variables. */
export const GET = route({ auth: "admin", query: z.object({ ref: z.string().min(1).max(300) }), burst: { limit: 60, windowMs: 60_000 } }, ({ query }) => lookupImage(query.ref));
