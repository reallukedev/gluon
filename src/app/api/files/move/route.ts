import { z } from "zod";
import { route } from "@/server/api";
import { moveItems } from "@/server/files/ops";
import { pathStr, policy, where } from "../_schemas";

/** Same-drive moves finish immediately ({ moved }); across drives a job starts ({ job }). */
export const POST = route(
  { auth: "user", body: z.object({ sources: z.array(pathStr).min(1).max(1000), dest: pathStr, conflict: policy.default("rename") }) },
  (ctx) => moveItems(ctx.user, ctx.body.sources, ctx.body.dest, ctx.body.conflict, where(ctx)),
);
