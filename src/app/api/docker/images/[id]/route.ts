import { z } from "zod";
import { route } from "@/server/api";
import { removeImage } from "@/server/dockerx/images";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { param } from "../../params";

const body = z.object({
  tag: z.string().max(400).optional(),
  withContainers: z.boolean().optional(),
  confirm: z.string().max(400).optional(),
});

/** Remove an image (or one of its tags). Refuses images running containers use. */
export const DELETE = route({ auth: "admin", recent: true, body }, async ({ params, body, user, ip, zone }) => {
  const id = param(params.id);
  try {
    const r = await removeImage(id, body);
    audit(user, { action: body.tag ? "docker.image.untag" : "docker.image.remove", target: body.tag ?? id, summary: r.message.replace(/\.$/, ""), detail: { id, removedContainers: r.removedContainers, freed: r.freed } }, { ip, zone });
    return { ok: true, message: r.message };
  } catch (e) {
    if (e instanceof AppError && e.code !== "confirm" && e.code !== "not_found") {
      audit(user, { action: "docker.image.remove", target: id, summary: `Tried to remove image ${id.replace(/^sha256:/, "").slice(0, 12)}`, detail: { error: e.message }, outcome: "failed" }, { ip, zone });
    }
    throw e;
  }
});
