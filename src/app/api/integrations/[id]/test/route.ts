import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getRecord, testContext } from "@/server/integrations/store";
import { runIntegrationTest } from "@/server/integrations/test";

/** Test a saved connection exactly as stored. Always 200; see `ok`. */
export const POST = route({ auth: "admin" }, async ({ params }) => {
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id);
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  return runIntegrationTest(rec.kind, testContext({ kind: rec.kind, baseUrl: rec.baseUrl, config: {}, id }), true);
});
