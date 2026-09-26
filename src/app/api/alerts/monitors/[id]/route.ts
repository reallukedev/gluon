import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { MONITOR_KINDS } from "@/lib/alerts-types";
import { monitorDetail, monitorView, patchMonitor, removeMonitor } from "@/server/monitors/service";

/** Detail: the view plus the latest 300 checks, outages in the last 30 days and a 7-day hourly strip. */
export const GET = route({ auth: "admin" }, ({ params }) => monitorDetail(String(params.id)));

const patch = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(80).optional(),
  kind: z.enum(MONITOR_KINDS).optional(),
  target: z.string().trim().min(1).max(2000).optional(),
  /** Only the fields you change. Automatic monitors: intervalSec, timeoutSec, failAfter. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** false = pause, true = resume. */
  enabled: z.boolean().optional(),
});

export const PATCH = route({ auth: "admin", body: patch }, ({ user, params, body, ip, zone }) => {
  const { before, after } = patchMonitor(String(params.id), body);
  const summary =
    body.enabled === false && before.enabled
      ? `Paused monitoring ${after.name}`
      : body.enabled === true && !before.enabled
        ? `Resumed monitoring ${after.name}`
        : `Changed monitor ${after.name}`;
  audit(user, { action: "monitor.updated", target: after.id, summary, detail: body }, { ip, zone });
  return monitorView(after.id);
});

export const DELETE = route({ auth: "admin" }, ({ user, params, ip, zone }) => {
  const m = removeMonitor(String(params.id));
  audit(user, { action: "monitor.deleted", target: m.id, summary: `Stopped watching ${m.name}` }, { ip, zone });
  return { ok: true };
});
