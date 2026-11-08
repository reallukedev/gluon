import { route } from "@/server/api";
import { serveGit } from "@/server/appstore/git-http";

/**
 * Read-only git smart HTTP for Gluon's Umbrel app store. Only this server and Docker's networks may
 * read it (see server/appstore/git-http.ts).
 */
const handler = route({ auth: "public", burst: { limit: 240, windowMs: 60_000 } }, ({ req, params }) => {
  const segments = Array.isArray(params.path) ? params.path : [String(params.path ?? "")];
  return serveGit(req, segments);
});

export const GET = handler;
export const POST = handler;
