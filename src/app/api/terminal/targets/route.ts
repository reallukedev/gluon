import { route } from "@/server/api";
import { listTargets } from "@/server/terminal/targets";

/** Where commands can run: the server and every container, grouped by app. */
export const GET = route({ auth: "admin" }, async () => listTargets());
