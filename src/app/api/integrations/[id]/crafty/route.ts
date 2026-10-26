import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { hasRecentAuth } from "@/server/auth/session";
import { AppError, badRequest } from "@/server/errors";
import { contextFor, getRecord, noteStatus, type IntegrationRecord } from "@/server/integrations/store";
import { forgetServers, runAction, serverName, serverNow } from "@/server/integrations/kinds/crafty";
import { CRAFTY_ACTIONS, type CraftyAction, type CraftyServerResult } from "@/lib/widgets-types";

const SERVER = z.string().regex(/^[a-z0-9-]{1,64}$/, "That isn't a Crafty server.");
const body = z.object({ server: SERVER, action: z.enum(CRAFTY_ACTIONS) });
const query = z.object({ server: SERVER });

function crafty(params: Record<string, string | string[]>): IntegrationRecord {
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id);
  const rec = getRecord(id);
  if (!rec) throw new AppError("not_found", "That connection is gone. It may have been removed in Settings.", 404);
  if (rec.kind !== "crafty") throw badRequest("That connected app isn't Crafty.");
  if (!rec.config) throw new AppError("integration_broken", rec.configError ?? "This connection needs to be set up again.", 409);
  return rec;
}

const VERB: Record<CraftyAction, string> = { start: "start", stop: "stop", restart: "restart", kill: "force-stop" };

/** One server as Crafty reports it right now, uncached: the widget polls this, backing off, while a command settles. */
export const GET = route({ auth: "admin", query, burst: { limit: 120, windowMs: 60_000 } }, async ({ params, query }): Promise<CraftyServerResult> => {
  const rec = crafty(params);
  // Leaves the widgets' shared cache alone: the widget keeps a settled answer until its own data catches up.
  return { server: await serverNow(contextFor(rec), query.server) };
});

/**
 * Start, stop, restart or force-stop a Crafty server. Admins only; force-stop also needs a recent sign-in, like
 * killing a container. Every command Gluon sends, and every one Crafty refuses, is in the activity log.
 */
export const POST = route({ auth: "admin", body, burst: { limit: 30, windowMs: 60_000 } }, async ({ user, session, body, params, ip, zone }): Promise<CraftyServerResult> => {
  if (body.action === "kill" && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const rec = crafty(params);
  const ctx = contextFor(rec);
  const name = (await serverName(ctx, body.server)) ?? body.server;
  const detail = { integration: rec.id, server: body.server, action: body.action };
  try {
    await runAction(ctx, body.server, body.action);
  } catch (e) {
    const message = e instanceof AppError ? e.message : "Crafty didn't answer.";
    audit(user, { action: `crafty.${body.action}`, target: body.server, summary: `Couldn't ${VERB[body.action]} “${name}” in Crafty`, detail: { ...detail, error: message }, outcome: "failed" }, { ip, zone });
    throw e;
  }
  noteStatus(rec.id, true, null);
  forgetServers(ctx);
  audit(user, { action: `crafty.${body.action}`, target: body.server, summary: `Asked Crafty to ${VERB[body.action]} “${name}”`, detail }, { ip, zone });
  // Crafty queues the command; what it looks like a moment later is the widget's first progress step.
  return { server: await serverNow(ctx, body.server).catch(() => null) };
});
