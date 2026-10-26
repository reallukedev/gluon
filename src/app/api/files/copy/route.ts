import { z } from "zod";
import { route } from "@/server/api";
import { copyItems } from "@/server/files/ops";
import { pathStr, policy, where } from "../_schemas";

/** Starts a copy job ({ job, skipped }); follow it on /api/files/jobs/stream. */
export const POST = route(
  { auth: "user", body: z.object({ sources: z.array(pathStr).min(1).max(1000), dest: pathStr, conflict: policy.default("rename") }) },
  (ctx) => copyItems(ctx.user, ctx.body.sources, ctx.body.dest, ctx.body.conflict, where(ctx)),
);
