import "server-only";
import { AppError } from "../errors";
import { KINDS } from "./registry";
import { noteStatus } from "./store";
import type { KindContext } from "./kinds/base";
import type { IntegrationKind, IntegrationTestResult } from "@/lib/widgets-types";

/** Run a kind's connection test with a hard ceiling, and remember the outcome for saved integrations. */
export async function runIntegrationTest(kind: IntegrationKind, ctx: KindContext<Record<string, unknown>>, remember: boolean): Promise<IntegrationTestResult> {
  const started = Date.now();
  const def = KINDS[kind];
  let outcome;
  try {
    outcome = await Promise.race([
      def.test(ctx),
      new Promise<never>((_, reject) => setTimeout(() => reject(new AppError("timeout", `${def.label} took too long to answer the test.`, 504)), 20_000).unref?.()),
    ]);
  } catch (e) {
    outcome = {
      ok: false,
      message: e instanceof AppError ? e.message : "The test failed unexpectedly.",
      detail: null,
      version: null,
      serverName: null,
      options: null,
      preview: null,
    };
  }
  if (remember && ctx.id) noteStatus(ctx.id, outcome.ok, outcome.ok ? null : outcome.message);
  return { ...outcome, ms: Date.now() - started };
}
