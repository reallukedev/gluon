import { z } from "zod";
import { route } from "@/server/api";
import { revealEnv } from "@/server/docker/detail";
import { audit } from "@/server/audit";

export const POST = route({ auth: "admin", recent: true, body: z.object({ container: z.string().max(200), key: z.string().max(200) }) }, async ({ params, body, user, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  const value = await revealEnv(id, body.container, body.key);
  audit(user, { action: "app.secret_viewed", target: id, summary: `Viewed the ${body.key} setting of ${body.container}` }, { ip, zone });
  return { value };
});
