import { z } from "zod";
import { route } from "@/server/api";
import { ping } from "@/server/diagnostics/tools";
import { hostField } from "@/server/diagnostics/validate";

const body = z.object({
  host: hostField,
  count: z.coerce.number().int().min(1).max(10).default(4),
  family: z.union([z.literal(4), z.literal(6)]).optional(),
});

/** Ping from the server. */
export const POST = route({ auth: "admin", body }, ({ body }) => ping(body.host, body.count, body.family));
