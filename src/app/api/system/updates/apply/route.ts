import { z } from "zod";
import { ndjson, route } from "@/server/api";
import { subscribe } from "@/server/events";
import { getRun, runBuffer, runTopic, startRun, type RunEvent } from "@/server/system/apt-runner";

const body = z.object({
  /** Only these packages; omit (or empty) for everything waiting. */
  packages: z.array(z.string().min(1).max(128)).max(1000).optional(),
  /** Finish an interrupted install (dpkg --configure -a) instead of upgrading. */
  repair: z.boolean().optional(),
});

/**
 * Start installing updates and stream the output as NDJSON (client: `streamPost`).
 *
 * Refusals (busy, another apt running, nothing to do, reauth) are normal HTTP errors, because the
 * run is started before the stream opens. Events:
 *   { type: "step", text, runId, run }      once, first
 *   { type: "line", text, stream: "out", n } apt/dpkg output
 *   { type: "done", ok, message, run }       when apt exits
 *
 * The install runs as a systemd unit on the host, so closing the page (or Docker restarting Gluon
 * mid-upgrade) doesn't stop it. Reattach with GET /api/system/updates/runs/[runId]/stream.
 */
export const POST = route({ auth: "admin", recent: true, body }, async ({ req, body, user, ip, zone }) => {
  const run = await startRun(user, body.repair ? { kind: "repair", packages: null } : { kind: "upgrade", packages: body.packages?.length ? body.packages : null }, { ip, zone });
  return ndjson(async (emit, signal) => {
    emit({ type: "step", text: run.kind === "repair" ? "Repairing interrupted updates…" : "Installing updates…", runId: run.id, run });
    const buf = runBuffer(run.id);
    buf?.lines.forEach((text, i) => emit({ type: "line", text, stream: "out", n: buf.from + i }));
    await new Promise<void>((resolve) => {
      let off = () => {};
      const finish = () => {
        off();
        resolve();
      };
      off = subscribe(runTopic(run.id), (d) => {
        const e = d as RunEvent;
        if (e.type === "line") emit({ type: "line", text: e.text, stream: "out", n: e.n });
        else {
          emit({ type: "done", ok: e.run.outcome === "ok", message: e.run.summary ?? (e.run.outcome === "ok" ? "Done." : "The update didn't finish."), run: e.run });
          finish();
        }
      });
      // A run that failed instantly may have finished before we subscribed.
      const now = getRun(run.id);
      if (now && now.outcome !== "running") {
        const { log, ...summary } = now;
        if (!buf) log.split("\n").forEach((text, n) => emit({ type: "line", text, stream: "out", n }));
        emit({ type: "done", ok: summary.outcome === "ok", message: summary.summary ?? "The update didn't finish.", run: summary });
        return finish();
      }
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }, req.signal);
});
