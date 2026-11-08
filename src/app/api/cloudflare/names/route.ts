import { z } from "zod";
import { route } from "@/server/api";
import { dropName, keepName } from "@/server/cloudflare/service";

/** Other names Gluon keeps pointed at this network, beyond its addresses. */
export const POST = route({ auth: "admin", body: z.object({ name: z.string().trim().min(1).max(253), proxied: z.boolean().default(false) }) }, ({ user, body, ip, zone }) => keepName(user, { ip, zone }, body));

export const DELETE = route({ auth: "admin", query: z.object({ name: z.string().trim().min(1).max(253) }) }, ({ user, query, ip, zone }) => dropName(user, { ip, zone }, query.name));
