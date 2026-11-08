import { z } from "zod";
import { route } from "@/server/api";
import { finishVoiceInstall } from "@/server/voice/install";

/** Waits for Mumble and sets its admin password, returned this once. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ draftId: z.string().min(1).max(64) }) }, ({ body, user, ip, zone }) => finishVoiceInstall(body.draftId, user, { ip, zone }));
