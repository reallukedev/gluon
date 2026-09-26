import { z } from "zod";
import { route } from "@/server/api";
import { routesResponse, saveRoutes } from "@/server/network/routes-service";

/** Public addresses: the routes model (routes.json), its revision and whether the Caddyfile drifted. */
export const GET = route({ auth: "admin" }, () => routesResponse());

const backend = z.object({ host: z.string().max(253), port: z.coerce.number().int(), tls: z.boolean().default(false) });

const body = z.object({
  rev: z.string().min(1).max(64),
  routes: z.array(z.record(z.string(), z.unknown())).max(200, "That's more addresses than Gluon supports (200)."),
  fallback: z.object({ name: z.string().max(60), app: z.string().max(80).nullable().optional(), backend }).optional(),
});

/** Replace the whole config. 409 `stale` (details.rev = current) when routes.json changed since `rev`. */
export const PUT = route({ auth: "admin", body, recent: true }, ({ user, body, ip, zone }) => saveRoutes(user, { ip, zone }, body));
