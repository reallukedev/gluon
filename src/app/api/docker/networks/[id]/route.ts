import { z } from "zod";
import { route } from "@/server/api";
import { removeNetwork } from "@/server/dockerx/networks";
import { audit } from "@/server/audit";
import { param } from "../../params";

/** Remove a network no container is connected to. */
export const DELETE = route({ auth: "admin", recent: true, body: z.object({ confirm: z.string().max(100).optional() }) }, async ({ params, body, user, ip, zone }) => {
  const id = param(params.id);
  const r = await removeNetwork(id, body.confirm);
  audit(user, { action: "docker.network.remove", target: id, summary: r.message.replace(/\.$/, "") }, { ip, zone });
  return { ok: true, message: r.message };
});
