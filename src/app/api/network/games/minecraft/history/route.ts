import { z } from "zod";
import { route } from "@/server/api";
import { mcHistory, restoreMcHistory } from "@/server/games/service";

/** Earlier versions of mc-router's routes file, newest first (Gluon keeps one before each change). */
export const GET = route({ auth: "admin" }, async () => ({ entries: await mcHistory() }));

/** Put an earlier version back. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ id: z.number().int().positive() }) }, async ({ body, user, ip, zone }) => restoreMcHistory(user, { ip, zone }, body.id));
