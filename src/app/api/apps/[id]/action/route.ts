import { z } from "zod";
import { route } from "@/server/api";
import { appAction, containerAction } from "@/server/docker/actions";
import { hasRecentAuth } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { audit } from "@/server/audit";

const body = z.union([
  z.object({ action: z.enum(["start", "stop", "restart", "down", "uninstall"]) }),
  z.object({ container: z.string().min(1).max(200), action: z.enum(["start", "stop", "restart", "pause", "unpause", "kill"]) }),
]);

export const POST = route({ auth: "admin", body }, async ({ params, body, user, session, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  if ("container" in body) {
    if (body.action === "kill" && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
    await containerAction(body.container, body.action);
    const verb = { start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", kill: "Force-stopped" }[body.action];
    audit(user, { action: `container.${body.action}`, target: id, summary: `${verb} container ${body.container}` }, { ip, zone });
    return { ok: true };
  }
  if ((body.action === "down" || body.action === "uninstall") && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const message = await appAction(id, body.action);
  audit(user, { action: `app.${body.action}`, target: id, summary: message }, { ip, zone });
  return { ok: true, message };
});
