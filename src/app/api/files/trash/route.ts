import { z } from "zod";
import { route } from "@/server/api";
import { deleteForever, listTrash, trashPaths } from "@/server/files/trash";
import { pathStr, where } from "../_schemas";

/** Admins see all trash; members see what they deleted. */
export const GET = route({ auth: "user" }, ({ user }) => listTrash(user));

/** Move paths to the trash (on each item's own drive). */
export const POST = route({ auth: "user", body: z.object({ paths: z.array(pathStr).min(1).max(1000) }) }, (ctx) => trashPaths(ctx.user, ctx.body.paths, where(ctx)));

/** Delete forever (admin, recent sign-in): { ids } or { all: true }. Returns a job. */
export const DELETE = route(
  { auth: "admin", recent: true, body: z.union([z.object({ ids: z.array(z.string().max(40)).min(1).max(5000) }), z.object({ all: z.literal(true) })]) },
  (ctx) => ({ job: deleteForever(ctx.user, "all" in ctx.body ? "all" : ctx.body.ids, where(ctx)) }),
);
