import { z } from "zod";
import { route } from "@/server/api";
import { disconnectContainer } from "@/server/dockerx/networks";
import { audit } from "@/server/audit";
import { param } from "../../../params";

/** Disconnect a container from a network. It can break how an app's parts reach each other, so it asks for re-auth. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ container: z.string().min(1).max(200) }) }, async ({ params, body, user, ip, zone }) => {
  const id = param(params.id);
  const r = await disconnectContainer(id, body.container);
  audit(user, { action: "docker.network.disconnect", target: id, summary: r.message.split(". ")[0]!.replace(/\.$/, ""), detail: { container: body.container } }, { ip, zone });
  return { ok: true, message: r.message };
});
