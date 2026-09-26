import { z } from "zod";
import { route } from "@/server/api";
import { restore } from "@/server/files/trash";
import { where } from "../../_schemas";

/** Put items back. conflict "rename" restores as "name (restored)"; "fail" answers 409 so the UI can ask. */
export const POST = route(
  { auth: "user", body: z.object({ ids: z.array(z.string().max(40)).min(1).max(1000), conflict: z.enum(["rename", "fail"]).default("fail") }) },
  (ctx) => restore(ctx.user, ctx.body.ids, ctx.body.conflict, where(ctx)),
);
