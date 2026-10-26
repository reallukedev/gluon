import { z } from "zod";
import { route } from "@/server/api";
import { extractArchive } from "@/server/files/extract";
import { pathStr, where } from "../_schemas";

/** Extract an archive into a sibling folder. Starts a job. */
export const POST = route({ auth: "user", body: z.object({ path: pathStr }) }, async (ctx) => ({ job: await extractArchive(ctx.user, ctx.body.path, where(ctx)) }));
