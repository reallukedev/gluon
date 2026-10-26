import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { monitorInputSchema } from "@/lib/alerts-types";
import { createUserMonitor, monitorView } from "@/server/monitors/service";
import { monitorsFor } from "@/server/monitors/ranged";

const query = z.object({
  /**
   * The history each monitor carries in `strip`:
   * 24h = 96 quarter-hours, 7d = 168 hours; omitted = the last 48 hours by hour.
   */
  range: z.enum(["24h", "7d"]).optional(),
});

/** Every monitor with its current state, uptime, latency percentiles and a history strip. */
export const GET = route({ auth: "admin", query }, ({ query }) => monitorsFor(query.range));

export const POST = route({ auth: "admin", body: monitorInputSchema }, ({ user, body, ip, zone }) => {
  const m = createUserMonitor(body);
  audit(user, { action: "monitor.created", target: m.id, summary: `Started watching ${m.name} (${m.target})` }, { ip, zone });
  return monitorView(m.id);
});
