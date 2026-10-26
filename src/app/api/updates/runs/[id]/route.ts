import { route } from "@/server/api";
import { runLog } from "@/server/updates";

/** One update: its state and the updater's output. */
export const GET = route({ auth: "admin" }, ({ params }) => runLog(String(params.id)));
