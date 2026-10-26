import { z } from "zod";
import { route } from "@/server/api";
import { prepareZip, streamZip } from "@/server/files/zip";
import { pathStr } from "../_schemas";

/** Estimate a zip download and get a token for it. */
export const POST = route({ auth: "user", body: z.object({ paths: z.array(pathStr).min(1).max(1000) }) }, ({ user, body }) => prepareZip(user, body.paths));

/** Stream the zip: ?token=… (from POST) or ?path=<folder> directly. */
export const GET = route(
  { auth: "user", query: z.object({ token: z.string().max(100).optional(), path: pathStr.optional() }) },
  ({ req, user, query }) => streamZip(req, user, query),
);
