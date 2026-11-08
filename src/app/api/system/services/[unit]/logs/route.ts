import { z } from "zod";
import { route } from "@/server/api";
import { journal } from "@/server/system/services";
import { parseUnit } from "@/server/system/units";

const query = z.object({
  lines: z.coerce.number().int().min(1).max(2000).optional(),
  /** Epoch ms: entries before this (load older). */
  before: z.coerce.number().int().positive().optional(),
  /** 0–7; 3 = errors and worse, 4 = warnings and worse. */
  priority: z.coerce.number().int().min(0).max(7).optional(),
  q: z.string().max(200).optional(),
});

export const GET = route({ auth: "admin", query }, async ({ params, query }) => ({
  entries: await journal(parseUnit(params.unit), { lines: query.lines, before: query.before, priority: query.priority, grep: query.q?.trim() || undefined }),
}));
