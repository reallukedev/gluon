import { z } from "zod";
import { route } from "@/server/api";
import { usedBy } from "@/server/files/apps";
import { pathStr } from "../_schemas";

/** Apps whose containers mount this folder, a folder above it, or a folder inside it. */
export const GET = route({ auth: "admin", query: z.object({ path: pathStr }) }, ({ user, query }) => usedBy(user, query.path));
