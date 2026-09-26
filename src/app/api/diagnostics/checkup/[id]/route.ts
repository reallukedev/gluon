import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getRun } from "@/server/diagnostics/checkup/history";
import { stopRun } from "@/server/diagnostics/checkup/runner";

/** A stored checkup run with its results and what changed since the one before. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const run = getRun(String(params.id));
  if (!run) throw notFound("That checkup");
  return run;
});

/** Stop a run in progress (everyone watching it sees it stop). */
export const DELETE = route({ auth: "admin" }, ({ params }) => {
  const stopped = stopRun(String(params.id));
  return { stopped };
});
