import { z } from "zod";
import { route } from "@/server/api";
import { traceroute } from "@/server/diagnostics/tools";
import { hostField } from "@/server/diagnostics/validate";

const body = z.object({
  host: hostField,
  maxHops: z.coerce.number().int().min(1).max(30).default(20),
});

/** Trace the route to a host (traceroute or tracepath on the server; says so if neither exists). */
export const POST = route({ auth: "admin", body }, ({ body }) => traceroute(body.host, body.maxHops));
