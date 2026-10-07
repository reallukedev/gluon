import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { callsStatus, startCalls, stopCalls } from "@/server/chat/calls";

/** The call relay and whether it's reachable. */
export const GET = route({ auth: "admin" }, async ({ params }) => callsStatus(param(params.app)));

/** Start setting calls up: installs the relay when there isn't one (publish its draft next), then /finish. */
export const POST = route({ auth: "admin", recent: true, burst: { limit: 5, windowMs: 60_000 } }, async ({ params, user, ip, zone }) => startCalls(user, { ip, zone }, param(params.app)));

/** Turn calls off. The relay app stays, in case they come back; uninstall it from Apps. */
export const DELETE = route({ auth: "admin", recent: true }, async ({ params, user, ip, zone }) => stopCalls(user, { ip, zone }, param(params.app)));
