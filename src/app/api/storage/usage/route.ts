import { z } from "zod";
import { route } from "@/server/api";
import { latestUsage, runningUsage, startUsage, validateUsagePath } from "@/server/storage/usage";
import { dockerUsage } from "@/server/storage/cleanup";

const pathQuery = z.string().min(1).max(4096).startsWith("/");

/**
 * GET /api/storage/usage?path=/mnt/hdd2: the last finished scan of that folder (result: UsageResult)
 * and any scan in progress. Without ?path: running scans and Docker's own usage (images, containers,
 * volumes, build cache).
 */
export const GET = route({ auth: "admin", query: z.object({ path: pathQuery.optional() }) }, async ({ query }) => {
  if (!query.path) return { running: runningUsage(), docker: await dockerUsage() };
  const p = await validateUsagePath(query.path);
  return { path: p, latest: latestUsage(p), running: runningUsage(p)[0] ?? null };
});

/**
 * POST /api/storage/usage { path }: start (or join) a scan; returns the job. Follow it with
 * GET /api/storage/operations/:id/stream or poll GET /api/storage/operations/:id.
 */
export const POST = route({ auth: "admin", body: z.object({ path: pathQuery }) }, async ({ body, user }) => ({ job: await startUsage(user, body.path) }));
