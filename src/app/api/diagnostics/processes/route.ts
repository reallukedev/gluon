import { route, sse } from "@/server/api";
import { subscribeProcesses } from "@/server/diagnostics/processes";

/** Top processes by CPU and memory every 2.5 s. Events: `processes` ProcessSnapshot, `error` { message }. */
export const GET = route({ auth: "admin" }, ({ req }) =>
  sse(req, (send) =>
    subscribeProcesses(
      (s) => send("processes", s),
      (e) => send("error", { message: `Couldn't read the process list: ${e.message}` }),
    ),
  ),
);
