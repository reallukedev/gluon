import { route } from "@/server/api";
import { runLog } from "@/server/updates";

export const GET = route({ auth: "admin" }, ({ params }) => runLog(String(params.id)));
