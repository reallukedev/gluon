import { route, sse } from "@/server/api";
import { notFound } from "@/server/errors";
import { getJob, pipeJob } from "@/server/storage/oplog";

/** Reattach after a reload. Same payloads as the NDJSON stream. */
export const GET = route({ auth: "admin" }, ({ req, params }) => {
  const id = String(params.id);
  if (!getJob(id)) throw notFound("That operation");
  return sse(req, (send, close) => {
    const ctrl = new AbortController();
    void pipeJob(id, (e) => send(String(e.type), e), ctrl.signal).then(close);
    return () => ctrl.abort();
  });
});
