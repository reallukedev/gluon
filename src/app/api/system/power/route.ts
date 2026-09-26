import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { cancelScheduled, powerNow, powerStatus, schedulePower } from "@/server/system/power";

/** Pending scheduled restart/shutdown, whether an update is running, and reboot-required. */
export const GET = route({ auth: "admin" }, () => powerStatus());

const body = z.object({
  action: z.enum(["restart", "shutdown"]),
  /** "now" (in 3 seconds) or "HH:MM" (server time, next occurrence within 24 h). */
  when: z.union([z.literal("now"), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time like 03:30.")]).default("now"),
  /** Go ahead even though updates are being installed. */
  force: z.boolean().optional(),
});

export const POST = route({ auth: "admin", recent: true, body }, async ({ body, user, ip, zone }) => {
  const label = body.action === "restart" ? "restart" : "shut down";
  if (body.when === "now") {
    // Audit first: the machine is going down in 3 seconds.
    audit(user, { action: `system.power.${body.action}`, target: "server", summary: body.action === "restart" ? "Restarted the server" : "Shut down the server", detail: { force: !!body.force } }, { ip, zone });
    try {
      const r = await powerNow(body.action, { force: body.force });
      return { ok: true, at: r.at, message: body.action === "restart" ? "Restarting in 3 seconds. Gluon will be back in a few minutes." : "Shutting down in 3 seconds. Someone will need to turn it back on." };
    } catch (e) {
      audit(user, { action: `system.power.${body.action}`, target: "server", summary: `Tried to ${label} the server`, detail: { error: (e as Error).message }, outcome: "failed" }, { ip, zone });
      throw e;
    }
  }
  const scheduled = await schedulePower(body.action, body.when);
  audit(user, { action: `system.power.schedule`, target: "server", summary: `Scheduled a ${label} for ${body.when}`, detail: { action: body.action, at: scheduled?.at } }, { ip, zone });
  return { ok: true, scheduled };
});

/** Cancel a scheduled restart/shutdown. */
export const DELETE = route({ auth: "admin", recent: true }, async ({ user, ip, zone }) => {
  const cancelled = await cancelScheduled();
  if (cancelled) audit(user, { action: "system.power.cancel", target: "server", summary: "Cancelled the scheduled restart" }, { ip, zone });
  return { ok: true, cancelled };
});
