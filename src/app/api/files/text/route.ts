import { z } from "zod";
import { route } from "@/server/api";
import { readText, saveText } from "@/server/files/text";
import { pathStr, where } from "../_schemas";

/** First 1 MB of a file as text, with encoding detection and whether it can be edited here. */
export const GET = route({ auth: "user", query: z.object({ path: pathStr }) }, ({ user, query }) => readText(user, query.path));

/** Save a small text file. expectedMtime must match the file (else 409 "changed"); create:true makes a new file. */
export const PUT = route(
  {
    auth: "user",
    body: z.object({
      path: pathStr,
      content: z.string().max(4 * 1024 * 1024),
      expectedMtime: z.number().nullable(),
      create: z.boolean().optional(),
    }),
  },
  (ctx) => saveText(ctx.user, ctx.body, where(ctx)),
);
