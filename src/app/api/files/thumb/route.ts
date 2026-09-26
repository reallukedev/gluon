import { z } from "zod";
import { route } from "@/server/api";
import { thumbnail } from "@/server/files/thumbs";
import { pathStr } from "../_schemas";

/** A small WebP thumbnail of an image (?size= 160, 320 or 480 px on the long side). 415 when there can't be one. */
export const GET = route({ auth: "user", query: z.object({ path: pathStr, size: z.coerce.number().int().min(64).max(960).default(320) }) }, ({ req, user, query }) => thumbnail(req, user, query.path, query.size));
