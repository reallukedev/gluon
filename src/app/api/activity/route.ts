import { z } from "zod";
import { route } from "@/server/api";
import { listActivity } from "@/server/audit";
import type { ActivityPage } from "@/lib/people-types";

const activityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  kind: z.enum(["user", "system"]).optional(),
  /** User id. */
  user: z.string().max(64).optional(),
  /** Exact target (app id, path, route…). */
  target: z.string().max(500).optional(),
  /** Free text over summary, target and action. */
  q: z.string().trim().max(200).optional(),
  /** "failed" = only things that failed or went wrong. */
  outcome: z.enum(["ok", "failed"]).optional(),
});

/** Who did what, newest first. Page with `before` = the last id you got. */
export const GET = route({ auth: "admin", query: activityQuery }, ({ query }): ActivityPage => {
  const items = listActivity({ before: query.before, limit: query.limit + 1, kind: query.kind, userId: query.user, target: query.target, q: query.q || undefined, outcome: query.outcome });
  const more = items.length > query.limit;
  const page = items.slice(0, query.limit);
  return { items: page, next: more ? page[page.length - 1]!.id : null };
});
