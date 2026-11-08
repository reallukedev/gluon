import { z } from "zod";
import { route } from "@/server/api";
import { activityPage } from "@/server/audit";

const activityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  kind: z.enum(["user", "system"]).optional(),
  user: z.string().max(64).optional(),
  target: z.string().max(500).optional(),
  q: z.string().trim().max(200).optional(),
  outcome: z.enum(["ok", "failed"]).optional(),
});

/** Newest first. Page with `before` set to the last id you got. */
export const GET = route({ auth: "admin", query: activityQuery }, ({ query }) =>
  activityPage({ before: query.before, limit: query.limit, kind: query.kind, userId: query.user, target: query.target, q: query.q || undefined, outcome: query.outcome }),
);
