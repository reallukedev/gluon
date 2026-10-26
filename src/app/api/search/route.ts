import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { runSearch, searchAll } from "@/server/search";
import { searchSetup } from "@/server/search-sources";
import { AppError } from "@/server/errors";
import { SCOPE_ID } from "@/lib/search-types";

const scope = z.string().regex(SCOPE_ID, "That isn't a place to search.").default("all");
const body = z.object({ q: z.string().max(200), scope });

/** Refuse scopes this person doesn't have (another member's connected app, files without access). */
async function setup(user: Parameters<typeof searchSetup>[0], scope: string) {
  const s = await searchSetup(user, scope);
  if (!s) throw new AppError("bad_scope", "You can't search there.", 403);
  return s;
}

/**
 * Universal search, streamed as NDJSON (SearchEvent): start → group / fail as each source answers →
 * done. POST keeps what people type out of URLs and access logs. Queries are never logged.
 */
export const POST = route({ auth: "user", body, burst: { limit: 40, windowMs: 10_000 } }, async ({ user, body, zone, req }) => {
  const { extra, grants } = await setup(user, body.scope);
  return ndjson((emit, signal) => runSearch(user, body.q, { scope: body.scope, zone, signal, emit, extra, grants }), req.signal);
});

/** Everything at once, for scripts and older clients. */
export const GET = route({ auth: "user", query: z.object({ q: z.string().max(200), scope }) }, async ({ user, query, zone, req }) => {
  const { extra, grants } = await setup(user, query.scope);
  return searchAll(user, query.q, { scope: query.scope, zone, extra, grants, signal: req.signal });
});
