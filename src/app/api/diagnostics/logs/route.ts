import { z } from "zod";
import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { dockerEventEntry, dockerEventsSnapshot, journalFollow, journalSnapshot, UNIT_RE } from "@/server/diagnostics/logs";
import type { DockerEvent } from "@/server/docker/events";
import type { LogEntry } from "@/lib/diagnostics-types";

const query = z.object({
  source: z.enum(["kernel", "journal", "docker"]).default("kernel"),
  unit: z.string().regex(UNIT_RE, "That doesn't look like a service name.").optional(),
  /** 0 emergency … 3 error, 4 warning … 7 debug: show this level and more severe. */
  priority: z.coerce.number().int().min(0).max(7).optional(),
  lines: z.coerce.number().int().min(1).max(2000).default(300),
  follow: z.enum(["0", "1"]).default("1"),
});

/**
 * Kernel log, system journal (unit/priority filters) or Docker events. Events:
 *  snapshot { entries: LogEntry[] } (oldest first)
 *  entries  LogEntry[] (new entries, batched)
 *  error    { message } (the follower stopped)
 */
export const GET = route({ auth: "admin", query }, ({ req, query }) =>
  sse(req, async (send, close) => {
    if (query.source === "docker") {
      send("snapshot", { entries: dockerEventsSnapshot(query.lines) });
      if (query.follow === "0") return close();
      return subscribe("docker.event", (d) => send("entries", [dockerEventEntry(d as DockerEvent)]));
    }
    const q = { kernel: query.source === "kernel", unit: query.source === "journal" ? query.unit : undefined, priority: query.priority, lines: query.lines };
    const entries = await journalSnapshot(q);
    send("snapshot", { entries });
    if (query.follow === "0") return close();
    let batch: LogEntry[] = [];
    const flush = setInterval(() => {
      if (!batch.length) return;
      send("entries", batch);
      batch = [];
    }, 300);
    const stop = journalFollow(
      { ...q, afterCursor: entries.at(-1)?.cursor ?? null },
      (e) => {
        batch.push(e);
        if (batch.length > 1000) batch = batch.slice(-1000);
      },
      (err) => {
        send("error", { message: err ? `The log stopped: ${err}` : "The log stopped." });
        close();
      },
    );
    return () => {
      clearInterval(flush);
      stop();
    };
  }),
);
