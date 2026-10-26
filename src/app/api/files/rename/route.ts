import { z } from "zod";
import { route } from "@/server/api";
import { renamePath } from "@/server/files/ops";
import { pathStr, where } from "../_schemas";

export const POST = route({ auth: "user", body: z.object({ path: pathStr, name: z.string().min(1).max(1024) }) }, (ctx) => renamePath(ctx.user, ctx.body.path, ctx.body.name, where(ctx)));
