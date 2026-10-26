import { z } from "zod";
import { route } from "@/server/api";
import { applyOwnership } from "@/server/files/apps";
import { pathStr, where } from "../_schemas";

/** Give a folder tree to an app's user (PUID/PGID or user:). Starts a job; its result carries `undo`. */
export const POST = route(
  {
    auth: "admin",
    recent: true,
    body: z.object({ path: pathStr, app: z.string().max(200).optional(), uid: z.number().int().min(0).max(4294967294).optional(), gid: z.number().int().min(0).max(4294967294).optional() }),
  },
  async (ctx) => ({ job: await applyOwnership(ctx.user, ctx.body, where(ctx)) }),
);
