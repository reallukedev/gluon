import { z } from "zod";
import { route } from "@/server/api";
import { disableTunnel, enableTunnel, restartConnector } from "@/server/cloudflare/service";

/** Turn the Cloudflare Tunnel on, or restart its connector. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ action: z.enum(["enable", "restart"]).default("enable") }) }, ({ user, body, ip, zone }) =>
  body.action === "restart" ? restartConnector(user, { ip, zone }) : enableTunnel(user, { ip, zone }),
);

export const DELETE = route({ auth: "admin", recent: true }, ({ user, ip, zone }) => disableTunnel(user, { ip, zone }));
