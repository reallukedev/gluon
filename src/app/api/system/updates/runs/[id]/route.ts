import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getRun } from "@/server/system/apt-runner";

/** One run with its full log. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const run = getRun(String(params.id));
  if (!run) throw notFound("That update run");
  return run;
});
