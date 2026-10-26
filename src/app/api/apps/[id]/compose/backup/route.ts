import { z } from "zod";
import { route } from "@/server/api";
import { readBackup } from "@/server/docker/compose";

export const GET = route({ auth: "admin", query: z.object({ name: z.string().max(200) }) }, async ({ params, query }) => ({
  content: await readBackup(decodeURIComponent(String(params.id)), query.name),
}));
