import { route } from "@/server/api";
import { gamesStatus } from "@/server/games/service";

export const GET = route({ auth: "admin" }, async () => gamesStatus());
