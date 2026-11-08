import { z } from "zod";
import { route, sse } from "@/server/api";
import { getApp } from "@/server/docker/apps";
import { followLogs, tailLogs, type LogLine } from "@/server/docker/logs";
import { notFound } from "@/server/errors";

const query = z.object({
  container: z.string().max(200).optional(),
  tail: z.coerce.number().int().min(10).max(5000).default(400),
});

export const GET = route({ auth: "admin", query }, async ({ req, params, query }) => {
  const app = await getApp(decodeURIComponent(String(params.id)));
  if (!app) throw notFound("That app");
  const targets = query.container ? app.containers.filter((c) => c.name === query.container) : app.containers;
  if (!targets.length) throw notFound("That container");
  return sse(req, async (send) => {
    // Followed from just before the history was read, so nothing written in between is lost.
    const from = Date.now() - 1000;
    const history = (await Promise.all(targets.map((c) => tailLogs(c.id, c.name, { tail: query.tail }).catch(() => [] as LogLine[])))).flat();
    history.sort((a, b) => a.t - b.t);
    send("history", history.slice(-query.tail * 2));
    const seen = new Map<string, number>();
    for (const l of history) seen.set(l.container, Math.max(seen.get(l.container) ?? 0, l.t));
    // Batch live lines so a chatty container doesn't flood the browser with events.
    let batch: LogLine[] = [];
    const timer = setInterval(() => {
      if (batch.length) {
        send("lines", batch);
        batch = [];
      }
    }, 250);
    const stops = await Promise.all(
      targets
        .filter((c) => c.state === "running" || c.state === "restarting")
        .map((c) =>
          followLogs(
            c.id,
            c.name,
            (l) => {
              if (l.t <= (seen.get(l.container) ?? 0)) return; // already sent with the history
              batch.push(l);
              if (batch.length > 2000) batch = batch.slice(-2000);
            },
            { since: from },
          ).catch(() => () => undefined),
        ),
    );
    const stop = () => {
      clearInterval(timer);
      stops.forEach((s) => s());
    };
    // The page may have gone while the streams were opening; nothing would close them later.
    if (req.signal.aborted) {
      stop();
      return;
    }
    return stop;
  });
});
