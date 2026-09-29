import { route } from "@/server/api";
import { createDraft, listCustomApps, storeStatus } from "@/server/appstore/service";
import { validateRef } from "@/server/appstore/github";
import { createSchema } from "@/server/appstore/schemas";
import type { CustomAppsResponse } from "@/lib/builder-types";

/** The apps you made, with where each runs and how it's doing, plus the state of Gluon's store. */
export const GET = route({ auth: "admin" }, async (): Promise<CustomAppsResponse> => {
  const [store, apps] = await Promise.all([storeStatus(), listCustomApps()]);
  return { store, apps };
});

/** Start a new app (a draft) from what the New app page gathered. */
export const POST = route({ auth: "admin", body: createSchema, maxBody: 1024 * 1024 }, async ({ body, user, ip, zone }) => {
  if (body.source === "github") {
    if (!body.github) return Response.json({ error: { code: "invalid", message: "Choose a repository first." } }, { status: 400 });
    validateRef({ owner: body.github.owner, repo: body.github.repo, branch: body.github.branch, path: body.github.path });
  }
  const github = body.github ? { ...body.github, builtCommit: null, builtAt: null, latestCommit: null, checkedAt: null } : null;
  const id = await createDraft(user, { ip, zone }, { source: body.source, spec: body.spec, secrets: body.secrets, github, token: body.token ?? null });
  return { id };
});
