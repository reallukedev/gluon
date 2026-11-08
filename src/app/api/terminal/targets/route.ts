import { route } from "@/server/api";
import { listTargets } from "@/server/terminal/targets";

export const GET = route({ auth: "admin" }, async () => listTargets());
