import { z } from "zod";
import { route } from "@/server/api";
import { finishChatInstall } from "@/server/chat/install";
import { installBody, toInstall } from "@/server/chat/install-schema";

const body = installBody.extend({ draftId: z.string().min(1).max(80) });

export const POST = route({ auth: "admin", recent: true, body, burst: { limit: 5, windowMs: 60_000 } }, async ({ body, user, ip, zone }) => finishChatInstall(user, { ip, zone }, body.draftId, toInstall(body)));
