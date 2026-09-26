import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { hasRecentAuth } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { getService, serviceAction } from "@/server/system/services";
import { friendlyName, parseUnit, policyFor } from "@/server/system/units";

export const GET = route({ auth: "admin" }, ({ params }) => getService(parseUnit(params.unit)));

const body = z.object({
  action: z.enum(["start", "stop", "restart", "reload", "enable", "disable"]),
  /** Required to stop/restart/disable Docker or containerd (takes every app down). */
  confirm: z.boolean().optional(),
});

/** Start/stop/restart/reload/enable/disable. Stop/disable of important services need a fresh sign-in. */
export const POST = route({ auth: "admin", body }, async ({ params, body, user, session, ip, zone }) => {
  const unit = parseUnit(params.unit);
  const pol = policyFor(unit);
  if (pol.needsRecentAuth.includes(body.action) && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  try {
    const r = await serviceAction(unit, body.action, { confirm: body.confirm });
    audit(user, { action: `system.service.${body.action}`, target: unit, summary: r.message, detail: { unit, queued: r.queued } }, { ip, zone });
    return r;
  } catch (e) {
    if (e instanceof AppError && (e.code === "confirm_required" || e.code === "invalid_unit" || e.code === "not_found")) throw e;
    audit(user, { action: `system.service.${body.action}`, target: unit, summary: `Tried to ${body.action} ${friendlyName(unit)}`, detail: { unit, error: (e as Error).message }, outcome: "failed" }, { ip, zone });
    throw e;
  }
});
