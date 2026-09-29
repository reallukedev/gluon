import { z } from "zod";
import { route } from "@/server/api";
import { createNetwork, listNetworks } from "@/server/dockerx/networks";
import { audit } from "@/server/audit";

export const GET = route({ auth: "admin" }, () => listNetworks());

const body = z.object({
  name: z.string().max(63),
  subnet: z.string().max(40).nullish(),
  gateway: z.string().max(40).nullish(),
  internal: z.boolean().optional(),
  attachable: z.boolean().optional(),
});

/** Create a bridge network. */
export const POST = route({ auth: "admin", body }, async ({ body, user, ip, zone }) => {
  const r = await createNetwork(body);
  audit(user, { action: "docker.network.create", target: body.name.trim(), summary: r.message.replace(/\.$/, ""), detail: { subnet: body.subnet ?? null, internal: !!body.internal } }, { ip, zone });
  return { ok: true, message: r.message, id: r.id };
});
