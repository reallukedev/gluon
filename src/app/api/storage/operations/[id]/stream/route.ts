import { route, sse } from "@/server/api";
import { notFound } from "@/server/errors";
import { getJob, pipeJob } from "@/server/storage/oplog";

/**
 * GET /api/storage/operations/:id/stream: SSE of one operation (reattach after a reload).
 * Events: job (snapshot), step, progress, done: same payloads as the NDJSON stream.
 */
export const GET = route({ auth: "admin" }, ({ req, params }) => {
  const id = String(params.id);
  if (!getJob(id)) throw notFound("That operation");
  return sse(req, (send, close) => {
    const ctrl = new AbortController();
    void pipeJob(id, (e) => send(String(e.type), e), ctrl.signal).then(close);
    return () => ctrl.abort();
  });
});
