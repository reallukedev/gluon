import { z } from "zod";
import { route } from "@/server/api";
import { portCheck } from "@/server/diagnostics/tools";
import { hostField, portField } from "@/server/diagnostics/validate";

const body = z.object({
  host: hostField,
  port: portField,
  timeoutMs: z.coerce.number().int().min(500).max(10_000).default(4000),
});

/** Can the server open a TCP connection to host:port? */
export const POST = route({ auth: "admin", body }, ({ body }) => portCheck(body.host, body.port, body.timeoutMs));
