import { route } from "@/server/api";
import { serveGit } from "@/server/appstore/git-http";

/**
 * Gluon's Umbrel app store over git's smart HTTP, read-only:
 *   GET  /api/appstore/<token>/<store>.git/info/refs?service=git-upload-pack
 *   POST /api/appstore/<token>/<store>.git/git-upload-pack
 * Only this server and Docker's networks may read it (see server/appstore/git-http.ts).
 */
const handler = route({ auth: "public", burst: { limit: 240, windowMs: 60_000 } }, ({ req, params }) => {
  const segments = Array.isArray(params.path) ? params.path : [String(params.path ?? "")];
  return serveGit(req, segments);
});

export const GET = handler;
export const POST = handler;
