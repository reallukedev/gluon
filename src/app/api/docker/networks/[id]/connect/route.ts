import { z } from "zod";
import { route } from "@/server/api";
import { connectContainer } from "@/server/dockerx/networks";
import { audit } from "@/server/audit";
import { param } from "../../../params";

/** Connect a container to a network, optionally at a fixed address. */
export const POST = route({ auth: "admin", body: z.object({ container: z.string().min(1).max(200), ip: z.string().max(40).nullish() }) }, async ({ params, body, user, ip, zone }) => {
  const id = param(params.id);
  const r = await connectContainer(id, body.container, body.ip);
  audit(user, { action: "docker.network.connect", target: id, summary: r.message.replace(/\.$/, "").split(". ")[0]!, detail: { container: body.container, ip: body.ip ?? null } }, { ip, zone });
  return { ok: true, message: r.message };
});
