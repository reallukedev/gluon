import { z } from "zod";
import { route } from "@/server/api";
import { DNS_TYPES, dnsLookup } from "@/server/diagnostics/tools";
import { hostField, resolverField } from "@/server/diagnostics/validate";

const body = z.object({
  name: hostField,
  type: z.enum(DNS_TYPES).default("A"),
  /** system | cloudflare | google | quad9 | an IP address */
  resolver: resolverField,
});

/** DNS lookup with dig. */
export const POST = route({ auth: "admin", body }, ({ body }) => dnsLookup(body.name, body.type, body.resolver));
