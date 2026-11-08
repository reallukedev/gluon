import { route } from "@/server/api";
import { interfaces } from "@/server/diagnostics/interfaces";

export const GET = route({ auth: "admin" }, async () => ({ interfaces: await interfaces() }));
