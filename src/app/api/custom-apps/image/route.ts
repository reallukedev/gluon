import { z } from "zod";
import { route } from "@/server/api";
import { lookupImage } from "@/server/appstore/images";

export const GET = route({ auth: "admin", query: z.object({ ref: z.string().min(1).max(300) }), burst: { limit: 60, windowMs: 60_000 } }, ({ query }) => lookupImage(query.ref));
