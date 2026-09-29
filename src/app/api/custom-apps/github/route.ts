import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { inspectRepo } from "@/server/appstore/github";
import { inspectSchema } from "@/server/appstore/schemas";
import { getAppRow, readSecrets } from "@/server/appstore/db";
import { parseGithub } from "@/lib/builder/names";

/** Read a repository: what's in it and what Gluon would make of it. The token is used, never echoed. */
export const POST = route({ auth: "admin", body: inspectSchema, burst: { limit: 20, windowMs: 60_000 } }, async ({ body }) => {
  const ref = parseGithub(body.repo);
  if (!ref) throw new AppError("invalid", "Enter a GitHub repository as owner/name or its github.com address.", 400, { field: "repo" });
  let token = body.token ?? undefined;
  if (!token && body.app) token = getAppRow(body.app) ? readSecrets(body.app).githubToken : undefined;
  return inspectRepo({ owner: ref.owner, repo: ref.repo, branch: body.branch?.trim() || ref.branch, path: (body.path ?? ref.path ?? "").trim().replace(/^\/+|\/+$/g, "") }, token);
});
