import { z } from "zod";
import { route, sse } from "@/server/api";
import { subscribeConnections } from "@/server/diagnostics/connections";

const query = z.object({
  /** Include loopback-to-loopback chatter between local services. */
  local: z.enum(["0", "1"]).default("0"),
  /** Look up names for remote addresses (cached; names appear over the next few updates). */
  resolve: z.enum(["0", "1"]).default("0"),
});

/** Active connections every 3 s. Events: `connections` ConnectionsSnapshot, `error` { message }. */
export const GET = route({ auth: "admin", query }, ({ req, query }) =>
  sse(req, (send) =>
    subscribeConnections(
      { includeLocal: query.local === "1", resolve: query.resolve === "1" },
      (s) => send("connections", s),
      (e) => send("error", { message: `Couldn't list connections: ${e.message}` }),
    ),
  ),
);
