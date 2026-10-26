import { z } from "zod";
import { route } from "@/server/api";
import { connectRouter, fixForwarding, forgetRouter, removeForwarding, routerStatus } from "@/server/router/service";

/** Which ports Gluon's apps need from the internet, and how the router stands on each. */
export const GET = route({ auth: "admin" }, async () => routerStatus());

/** Give Gluon the router's access code (checked by signing in, then stored encrypted). */
export const PUT = route(
  { auth: "admin", recent: true, body: z.object({ code: z.string().trim().min(4, "Enter the Device Access Code from the router's label.").max(32, "The access code is at most 32 characters.") }), burst: { limit: 5, windowMs: 60_000 } },
  async ({ body, user, ip, zone }) => connectRouter(user, { ip, zone }, body.code),
);

/** Forward what's missing, all of it or the needs listed. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ keys: z.array(z.string().max(40)).max(20).nullish() }), burst: { limit: 6, windowMs: 60_000 } }, async ({ body, user, ip, zone }) =>
  fixForwarding(user, { ip, zone }, body.keys ?? null),
);

/**
 * Stop forwarding one need, or a service Gluon made that nothing needs now (only ones Gluon set
 * up). With neither, forget the access code: answers `{ forgotten }` without asking the router.
 */
export const DELETE = route(
  { auth: "admin", recent: true, body: z.object({ key: z.string().max(40).nullish(), service: z.string().trim().min(1).max(64).nullish() }), burst: { limit: 10, windowMs: 60_000 } },
  async ({ body, user, ip, zone }) => {
    if (body.key) return removeForwarding(user, { ip, zone }, { key: body.key });
    if (body.service) return removeForwarding(user, { ip, zone }, { service: body.service });
    return forgetRouter(user, { ip, zone });
  },
);
