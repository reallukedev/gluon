import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { buildLog } from "@/server/appstore/db";

/** A build's full log, kept after it finished. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const b = buildLog(String(params.id), String(params.build));
  if (!b) throw notFound("That build");
  return b;
});
