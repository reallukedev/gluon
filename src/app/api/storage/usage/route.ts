import { z } from "zod";
import { route } from "@/server/api";
import { latestUsage, runningUsage, startUsage, validateUsagePath } from "@/server/storage/usage";
import { dockerUsage } from "@/server/storage/cleanup";

const pathQuery = z.string().min(1).max(4096).startsWith("/");

/** Without ?path: running scans and Docker's own usage. */
export const GET = route({ auth: "admin", query: z.object({ path: pathQuery.optional() }) }, async ({ query }) => {
  if (!query.path) return { running: runningUsage(), docker: await dockerUsage() };
  const p = await validateUsagePath(query.path);
  return { path: p, latest: latestUsage(p), running: runningUsage(p)[0] ?? null };
});

/** Starts (or joins) a scan; follow the job on /api/storage/operations/:id. */
export const POST = route({ auth: "admin", body: z.object({ path: pathQuery }) }, async ({ body, user }) => ({ job: await startUsage(user, body.path) }));
