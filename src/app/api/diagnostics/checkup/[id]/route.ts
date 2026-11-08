import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getRun } from "@/server/diagnostics/checkup/history";
import { stopRun } from "@/server/diagnostics/checkup/runner";

export const GET = route({ auth: "admin" }, ({ params }) => {
  const run = getRun(String(params.id));
  if (!run) throw notFound("That checkup");
  return run;
});

/** Stops the run for everyone watching it. */
export const DELETE = route({ auth: "admin" }, ({ params }) => {
  const stopped = stopRun(String(params.id));
  return { stopped };
});
