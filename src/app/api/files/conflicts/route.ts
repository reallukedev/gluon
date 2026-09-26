import { z } from "zod";
import { route } from "@/server/api";
import { findConflicts } from "@/server/files/ops";
import { pathStr } from "../_schemas";

/** Which of these names already exist in dest (ask before move/copy/upload). */
export const POST = route({ auth: "user", body: z.object({ sources: z.array(pathStr).min(1).max(1000), dest: pathStr }) }, ({ user, body }) =>
  findConflicts(user, body.sources, body.dest),
);
