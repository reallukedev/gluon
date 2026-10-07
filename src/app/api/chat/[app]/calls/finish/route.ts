import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { finishCalls } from "@/server/chat/calls";

/** Give Prosody the relay's secret and turn calls on. Safe to run again. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ draftId: z.string().min(1).max(80).nullable() }) }, async ({ params, body, user, ip, zone }) =>
  finishCalls(user, { ip, zone }, param(params.app), body.draftId),
);
