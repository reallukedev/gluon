import { z } from "zod";
import { route } from "@/server/api";
import { addMapping, reloadMcRouter, removeMapping, setFallback, updateMapping } from "@/server/games/service";

const rev = z.string().min(1).max(32);
const host = z.string().trim().min(1, "Enter the address players will type.").max(253);
const backend = z.string().trim().min(1, "Choose the server it reaches.").max(300);

/** Add an address: players who type `host` reach `backend` (host:port). */
export const POST = route({ auth: "admin", body: z.object({ host, backend, rev }), burst: { limit: 20, windowMs: 60_000 } }, async ({ body, user, ip, zone }) => addMapping(user, { ip, zone }, body));

/** Rename an address or change the server it reaches. */
export const PATCH = route(
  { auth: "admin", body: z.object({ host, rename: host.nullish(), backend: backend.nullish(), rev }), burst: { limit: 20, windowMs: 60_000 } },
  async ({ body, user, ip, zone }) => updateMapping(user, { ip, zone }, body),
);

/** Remove an address. */
export const DELETE = route({ auth: "admin", recent: true, body: z.object({ host, rev }) }, async ({ body, user, ip, zone }) => removeMapping(user, { ip, zone }, body));

/** Where players go when the address they typed isn't listed (null turns them away), or `reload` to make mc-router read its file again. */
export const PUT = route({ auth: "admin", body: z.object({ fallback: backend.nullish(), reload: z.boolean().optional(), rev: rev.optional() }), burst: { limit: 20, windowMs: 60_000 } }, async ({ body, user, ip, zone }) => {
  if (body.reload) return reloadMcRouter(user, { ip, zone });
  return setFallback(user, { ip, zone }, { backend: body.fallback ?? null, rev: body.rev ?? "" });
});
