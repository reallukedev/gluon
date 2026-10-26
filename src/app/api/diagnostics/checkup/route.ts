import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { checkupState } from "@/server/diagnostics/checkup/state";
import { startOrAttach, follow } from "@/server/diagnostics/checkup/runner";
import type { CheckupEvent } from "@/lib/diagnostics-types";

/** Runs in progress, the last full checkup with its results, recent runs, and what can be picked. */
export const GET = route({ auth: "admin" }, () => checkupState());

const body = z.object({
  kind: z.enum(["full", "app", "address", "internet", "server", "space", "drive", "safety"]),
  target: z.string().trim().min(1).max(200).nullable().default(null),
});

/**
 * Start a checkup (or attach to the same one already running) and stream it as NDJSON:
 * {type:"start", meta, plan, results, attached} → {type:"result", result}… → {type:"done", summary}.
 * Closing the request stops the run once nobody else is watching.
 */
export const POST = route({ auth: "admin", body }, async ({ body, user, ip, zone, req }) => {
  const target = body.kind === "app" || body.kind === "address" || body.kind === "drive" ? body.target : null;
  const { run, attached } = await startOrAttach(body.kind, target, user, { ip, zone });
  return ndjson((emit, signal) => follow(run, attached, (e: CheckupEvent) => emit(e), signal), req.signal);
});
