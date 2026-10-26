import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { AppError } from "@/server/errors";
import { followMove, movePlan, moveJob, moveRunning, startMove } from "@/server/apps/move";
import type { MoveEvent } from "@/lib/app-move-types";

/**
 * What moving the app to Gluon would do (nothing changes), plus a move that's running or just
 * ended. `?only=job` skips the plan (measuring folders takes a while) for following a move.
 */
export const GET = route({ auth: "admin", query: z.object({ only: z.enum(["job"]).optional() }) }, async ({ params, query }) => {
  const id = decodeURIComponent(String(params.id));
  const job = moveJob(id);
  if (moveRunning(id) || query.only === "job") return { plan: null, job, error: null };
  try {
    return { plan: await movePlan(id), job, error: null };
  } catch (e) {
    if (e instanceof AppError && e.status < 500) return { plan: null, job, error: { code: e.code, message: e.message } };
    throw e;
  }
});

const body = z.object({ planId: z.string().regex(/^[a-f0-9]{20}$/, "Review the move again.") });

/** Run a reviewed plan, streaming its progress. The move carries on if the page closes. */
export const POST = route({ auth: "admin", recent: true, body }, async ({ req, params, body, user, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  await startMove(id, body.planId, user, { ip, zone });
  return ndjson(
    (emit, signal) =>
      new Promise<void>((resolve) => {
        let stop: (() => void) | null = null;
        const finish = () => {
          stop?.();
          resolve();
        };
        stop = followMove(id, (e: MoveEvent) => {
          emit(e);
          if (e.type === "result") queueMicrotask(finish);
        });
        if (!stop || !moveRunning(id)) queueMicrotask(finish);
        signal.addEventListener("abort", finish);
      }),
    req.signal,
  );
});
