import { z } from "zod";
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

/**
 * A double click, a retried request or a second tab must not make two drafts. The page sends
 * a key per attempt; the same key within 10 minutes gets the first draft back.
 */
type Pending = { at: number; id: Promise<string> };
type G = typeof globalThis & { __gluonCreateKeys?: Map<string, Pending> };
const keys = ((globalThis as G).__gluonCreateKeys ??= new Map<string, Pending>());
const KEY_TTL = 10 * 60_000;

/** Start a new app (a draft) from what the New app page gathered. */
export const POST = route(
  { auth: "admin", body: createSchema, query: z.object({ key: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional() }), maxBody: 1024 * 1024 },
  async ({ body, query, user, ip, zone }) => {
    if (body.source === "github") {
      if (!body.github) return Response.json({ error: { code: "invalid", message: "Choose a repository first." } }, { status: 400 });
      validateRef({ owner: body.github.owner, repo: body.github.repo, branch: body.github.branch, path: body.github.path });
    }
    for (const [k, v] of keys) if (Date.now() - v.at > KEY_TTL) keys.delete(k);
    const key = query.key ? `${user.id}:${query.key}` : null;
    const seen = key ? keys.get(key) : undefined;
    if (seen) return { id: await seen.id, repeated: true };
    const github = body.github ? { ...body.github, builtCommit: null, builtAt: null, latestCommit: null, checkedAt: null } : null;
    const id = createDraft(user, { ip, zone }, { source: body.source, spec: body.spec, secrets: body.secrets, github, token: body.token ?? null });
    if (key) {
      keys.set(key, { at: Date.now(), id });
      // A failed create may be tried again with the same key.
      id.catch(() => keys.delete(key));
    }
    return { id: await id };
  },
);
