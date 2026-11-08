import { z } from "zod";
import { route } from "@/server/api";
import { connect, disconnect, setOptions, status } from "@/server/cloudflare/service";

/** The token is never sent back. */
export const GET = route({ auth: "admin" }, () => status());

const connectBody = z.object({
  /** Leave out to keep the saved token (moving to another domain the same token can see). */
  token: z.string().trim().max(400).optional(),
  zoneId: z.string().regex(/^[a-f0-9]{32}$/, "Pick a domain."),
});

export const POST = route({ auth: "admin", recent: true, body: connectBody, burst: { limit: 10, windowMs: 60_000 } }, ({ user, body, ip, zone }) => connect(user, { ip, zone }, body));

export const PATCH = route({ auth: "admin", body: z.object({ ipv6: z.boolean().optional(), proxied: z.boolean().optional() }) }, ({ user, body, ip, zone }) => setOptions(user, { ip, zone }, body));

export const DELETE = route({ auth: "admin", recent: true }, async ({ user, ip, zone }) => {
  await disconnect(user, { ip, zone });
  return status();
});
