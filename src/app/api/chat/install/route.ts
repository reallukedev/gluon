import { z } from "zod";
import { route } from "@/server/api";
import { installPlan, startChatInstall } from "@/server/chat/install";
import { installBody, toInstall } from "@/server/chat/install-schema";

/** Chat servers already here, ports in use, and Network's base domain, for the install flow. */
export const GET = route({ auth: "admin", query: z.object({ domain: z.string().max(253).optional() }) }, async ({ query }) => installPlan(query.domain ?? null));

/** Create the app; the client then runs the builder's publish stream, then /finish. */
export const POST = route({ auth: "admin", recent: true, body: installBody }, async ({ body, user, ip, zone }) => ({ draftId: await startChatInstall(user, { ip, zone }, toInstall(body)) }));
