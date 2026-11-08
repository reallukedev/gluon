import { route } from "@/server/api";
import { gamesStatus } from "@/server/games/service";

export const POST = route({ auth: "admin", burst: { limit: 6, windowMs: 60_000 } }, async () => gamesStatus({ force: true }));
