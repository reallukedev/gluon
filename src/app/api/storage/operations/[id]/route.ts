import { route } from "@/server/api";
import { AppError, notFound } from "@/server/errors";
import { audit } from "@/server/audit";
import { getJob } from "@/server/storage/oplog";
import { cancelUsage } from "@/server/storage/usage";

/** GET /api/storage/operations/:id — one operation with all its steps. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const job = getJob(String(params.id));
  if (!job) throw notFound("That operation");
  return job;
});

/** DELETE /api/storage/operations/:id — stop a running folder scan. (Renames and setups can't be cancelled midway.) */
export const DELETE = route({ auth: "admin" }, ({ params, user, ip, zone }) => {
  const job = getJob(String(params.id));
  if (!job) throw notFound("That operation");
  if (job.kind !== "usage") throw new AppError("not_cancellable", "This can't be stopped halfway; it finishes or puts everything back on its own.", 409);
  if (job.status !== "running" || !cancelUsage(job.id)) return { ok: true, message: "It had already finished." };
  audit(user, { action: "storage.usage.cancel", target: job.target, summary: `Stopped scanning ${job.target}` }, { ip, zone });
  return { ok: true, message: "Stopped." };
});
