import { z } from "zod";
import { route, sse } from "@/server/api";
import { listActivity } from "@/server/audit";
import { subscribe } from "@/server/events";

const query = z.object({
  kind: z.enum(["user", "system"]).optional(),
  user: z.string().max(64).optional(),
  target: z.string().max(500).optional(),
  q: z.string().trim().max(200).optional(),
  /** "failed" = only things that failed or went wrong. */
  outcome: z.enum(["ok", "failed"]).optional(),
});

/** Live tail: `event: activity` with one ActivityItem per new entry matching the filters. */
export const GET = route({ auth: "admin", query }, ({ req, query }) =>
  sse(req, (send) => {
    send("ready", { at: Date.now() });
    return subscribe("activity", (data) => {
      const id = Number((data as { id?: unknown } | null)?.id);
      if (!Number.isFinite(id)) return;
      // Re-read with the filters applied; the entry only comes back if it matches.
      const [entry] = listActivity({ before: id + 1, limit: 1, kind: query.kind, userId: query.user, target: query.target, q: query.q || undefined, outcome: query.outcome });
      if (entry && entry.id === id) send("activity", entry);
    });
  }),
);
