import { z } from "zod";
import { route } from "@/server/api";
import { mcHistory, restoreMcHistory } from "@/server/games/service";

/** Gluon keeps a copy of mc-router's routes file before each change. */
export const GET = route({ auth: "admin" }, async () => ({ entries: await mcHistory() }));

export const POST = route({ auth: "admin", recent: true, body: z.object({ id: z.number().int().positive() }) }, async ({ body, user, ip, zone }) => restoreMcHistory(user, { ip, zone }, body.id));
