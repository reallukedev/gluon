import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { contextFor, noteStatus, readableRecord, type IntegrationRecord } from "@/server/integrations/store";
import { callService, deviceClassOf, forgetStates, householdControlsOf, nameOf } from "@/server/integrations/kinds/homeassistant";
import { controlRefusal, planControl } from "@/server/integrations/kinds/homeassistant-map";
import type { HomeAssistantControlResult } from "@/lib/widgets-types";

// Loose on purpose: entity and action are checked by planControl inside the handler, so a refused one is still logged.
const body = z.object({
  entity: z.string().max(260),
  action: z.string().max(40),
});

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Press something on a Home Assistant widget: switch a light, run a scene, open a blind.
 * Admins may use any control Gluon offers; household members only what an admin shared with the household.
 * Every press that reaches Home Assistant, and every refused one (bad input, not allowed, not shared), is in the
 * activity log.
 */
export const POST = route({ auth: "user", body, burst: { limit: 40, windowMs: 60_000 } }, async ({ user, body, params, ip, zone }): Promise<HomeAssistantControlResult> => {
  const rawId = String(Array.isArray(params.id) ? params.id[0] : params.id);
  const integrationId = SAFE_ID.test(rawId) ? rawId : null;
  // Refusals name the entity by its id: a member may not learn the name of something that isn't shared.
  const refuse = (status: number, message: string): never => {
    audit(user, controlRefusal({ integrationId, entityId: body.entity, action: body.action, name: null, status, message }), { ip, zone });
    throw new AppError(status === 403 ? "forbidden" : status === 404 ? "not_found" : "bad_request", message, status);
  };

  let rec: IntegrationRecord;
  try {
    rec = readableRecord(user, rawId);
  } catch (e) {
    if (e instanceof AppError) refuse(e.status, e.message);
    throw e;
  }
  if (rec!.kind !== "homeassistant") refuse(400, "That connected app has nothing to switch.");
  const ctx = contextFor(rec!);
  // Members never open a garage, gate or door from Gluon; that needs to know what the thing is.
  const deviceClass = user.role === "admin" ? null : await deviceClassOf(ctx, body.entity).catch(() => null);
  const plan = planControl({ role: user.role, entityId: body.entity, action: body.action, householdAllowed: householdControlsOf(rec!.config), deviceClass });
  if (!plan.ok) return refuse(plan.status, plan.message);

  const known = (await nameOf(ctx, body.entity)) ?? body.entity;
  const detail = { integration: rec!.id, entity: body.entity, action: body.action };
  const summary = `${plan.verb} “${known}” in Home Assistant`;
  try {
    const entity = await callService(ctx, plan, body.entity);
    forgetStates(ctx);
    noteStatus(rec!.id, true, null);
    audit(user, { action: "integration.control", summary, target: body.entity, detail: { ...detail, service: `${plan.domain}.${plan.service}` } }, { ip, zone });
    return { entity };
  } catch (e) {
    const message = e instanceof AppError ? e.message : "Home Assistant didn't answer.";
    audit(user, { action: "integration.control", summary: `Couldn't change “${known}” in Home Assistant`, target: body.entity, detail: { ...detail, error: message }, outcome: "failed" }, { ip, zone });
    throw e;
  }
});
