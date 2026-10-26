import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { testContext } from "@/server/integrations/store";
import { runIntegrationTest } from "@/server/integrations/test";
import { INTEGRATION_KINDS, type IntegrationTestResult } from "@/lib/widgets-types";

const body = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  baseUrl: z.string().max(2048),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Editing a saved connection: secrets left empty are taken from it. */
  id: z.string().max(64).optional(),
});

/** Test settings before saving them. Always 200 with `ok`, except for invalid input (400). */
export const POST = route({ auth: "admin", body }, async ({ body }): Promise<IntegrationTestResult> => {
  let ctx;
  try {
    ctx = testContext(body);
  } catch (e) {
    if (e instanceof AppError && e.status === 400) {
      return { ok: false, message: e.message, detail: null, version: null, serverName: null, options: null, preview: null, ms: 0 };
    }
    throw e;
  }
  return runIntegrationTest(body.kind, ctx, false);
});
