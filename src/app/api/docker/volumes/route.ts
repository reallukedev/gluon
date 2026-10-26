import { z } from "zod";
import { route } from "@/server/api";
import { createVolume, listVolumes } from "@/server/dockerx/volumes";
import { audit } from "@/server/audit";

export const GET = route({ auth: "admin" }, () => listVolumes());

/** Create an empty local volume. */
export const POST = route({ auth: "admin", body: z.object({ name: z.string().max(128) }) }, async ({ body, user, ip, zone }) => {
  const r = await createVolume(body.name, { "app.gluon.created": "1" });
  audit(user, { action: "docker.volume.create", target: body.name.trim(), summary: r.message.replace(/\.$/, "") }, { ip, zone });
  return { ok: true, message: r.message };
});
