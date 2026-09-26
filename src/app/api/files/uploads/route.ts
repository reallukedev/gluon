import { z } from "zod";
import { route } from "@/server/api";
import { initUpload, listUploads } from "@/server/files/upload";
import { pathStr, policy } from "../_schemas";

/** My unfinished (and recently finished) uploads, for resuming after a reload. */
export const GET = route({ auth: "user" }, ({ user }) => listUploads(user));

/** Start an upload. Checks write access, name, and free space before any bytes are sent. */
export const POST = route(
  {
    auth: "user",
    body: z.object({
      dir: pathStr,
      name: z.string().min(1).max(1024),
      size: z.number().int().min(0),
      lastModified: z.number().nullable().optional(),
      conflict: policy.default("rename"),
    }),
  },
  ({ user, body }) => initUpload(user, body),
);
