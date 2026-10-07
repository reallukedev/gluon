import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { operationBody } from "@/server/storage/schemas";
import { listJobs, pipeJob } from "@/server/storage/oplog";
import { mountVolume, unmountTarget, persistMounts } from "@/server/storage/ops";
import { runCleanup } from "@/server/storage/cleanup";
import { startRename } from "@/server/storage/rename";
import { startSetup } from "@/server/storage/setup";

/** GET /api/storage/operations?kind=&limit=: recent storage operations (newest first). */
export const GET = route(
  {
    auth: "admin",
    query: z.object({
      kind: z.enum(["rename", "setup", "usage", "cleanup", "mount", "unmount", "persist"]).optional(),
      target: z.string().max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  ({ query }) => listJobs({ kind: query.kind, target: query.target, limit: query.limit }),
);

/**
 * POST /api/storage/operations: change something (admin, re-auth within 10 min).
 * mount / unmount / persist / cleanup answer with JSON { message, … } when done.
 * rename / setup start a background job and answer with an NDJSON stream of its steps
 * ({type:"job"}, {type:"step"}…, {type:"done", ok, status, message}). Closing the stream doesn't stop
 * the job; follow it again with GET /api/storage/operations/:id/stream.
 */
export const POST = route({ auth: "admin", recent: true, body: operationBody }, async ({ body, user, ip, zone, req }) => {
  const where = { ip, zone };
  switch (body.op) {
    case "mount":
      return mountVolume(user, body, where);
    case "unmount":
      return unmountTarget(user, body, where);
    case "persist":
      return persistMounts(user, { targets: body.targets, noatime: body.noatime }, where);
    case "cleanup":
      return runCleanup(user, body, where);
    case "rename": {
      const job = await startRename(user, body, where);
      return ndjson((emit, signal) => pipeJob(job.id, emit, signal), req.signal);
    }
    case "setup": {
      const job = await startSetup(user, body, where);
      return ndjson((emit, signal) => pipeJob(job.id, emit, signal), req.signal);
    }
  }
});
