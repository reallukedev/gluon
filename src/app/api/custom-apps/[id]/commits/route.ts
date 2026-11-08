import { route } from "@/server/api";
import { checkCommits } from "@/server/appstore/service";

export const POST = route({ auth: "admin", burst: { limit: 10, windowMs: 60_000 } }, ({ params }) => checkCommits(String(params.id)));
