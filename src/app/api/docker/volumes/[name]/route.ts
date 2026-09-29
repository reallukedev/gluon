import { z } from "zod";
import { route } from "@/server/api";
import { removeVolume } from "@/server/dockerx/volumes";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { param } from "../../params";

/** Remove a volume nothing uses, and everything in it. */
export const DELETE = route({ auth: "admin", recent: true, body: z.object({ confirm: z.string().max(200).optional() }) }, async ({ params, body, user, ip, zone }) => {
  const name = param(params.name);
  try {
    const r = await removeVolume(name, body.confirm);
    audit(user, { action: "docker.volume.remove", target: name, summary: r.message.replace(/\.$/, ""), detail: { freed: r.freed } }, { ip, zone });
    return { ok: true, message: r.message };
  } catch (e) {
    if (e instanceof AppError && e.code !== "confirm" && e.code !== "not_found") {
      audit(user, { action: "docker.volume.remove", target: name, summary: `Tried to remove volume ${name.slice(0, 40)}`, detail: { error: e.message }, outcome: "failed" }, { ip, zone });
    }
    throw e;
  }
});
