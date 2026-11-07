import { z } from "zod";
import { route } from "@/server/api";
import { checkSavedToken, checkToken } from "@/server/cloudflare/service";

/**
 * What a token can do: its domains, and whether it can edit DNS and see tunnels. Saves nothing.
 * `saved` checks the token Gluon already has (moving to another domain).
 */
const body = z.union([
  z.object({ saved: z.literal(true) }),
  z.object({ token: z.string().trim().min(20, "That's too short to be a Cloudflare token.").max(400), zoneId: z.string().max(64).nullable().optional() }),
]);

export const POST = route({ auth: "admin", body, burst: { limit: 20, windowMs: 60_000 } }, ({ body }) => ("saved" in body ? checkSavedToken() : checkToken(body.token, body.zoneId)));
