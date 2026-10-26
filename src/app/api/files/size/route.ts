import { z } from "zod";
import { route } from "@/server/api";
import { folderSize } from "@/server/files/du";
import { flag, pathStr } from "../_schemas";

/**
 * Folder size (disk usage). Returns the cached number immediately and starts a background
 * calculation when it's missing, older than an hour, or ?refresh=1. Poll while running.
 */
export const GET = route({ auth: "user", query: z.object({ path: pathStr, refresh: flag }) }, ({ user, query }) => folderSize(user, query.path, query.refresh));
