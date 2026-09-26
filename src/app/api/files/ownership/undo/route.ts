import { z } from "zod";
import { route } from "@/server/api";
import { undoOwnership } from "@/server/files/apps";
import { where } from "../../_schemas";

/** Put back the owners recorded by an ownership job (job.result.undo). */
export const POST = route({ auth: "admin", recent: true, body: z.object({ jobId: z.string().min(6).max(40) }) }, async (ctx) => ({
  job: await undoOwnership(ctx.user, ctx.body.jobId, where(ctx)),
}));
