import { z } from "zod";
import { route } from "@/server/api";
import { finishVoiceInstall } from "@/server/voice/install";

/** After the publish: wait for Mumble and set its admin password, returned this once. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ draftId: z.string().min(1).max(64) }) }, ({ body, user, ip, zone }) => finishVoiceInstall(body.draftId, user, { ip, zone }));
