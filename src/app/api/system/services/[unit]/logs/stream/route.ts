import { z } from "zod";
import { route, sse } from "@/server/api";
import { followJournal, JOURNAL_CURSOR_RE } from "@/server/system/services";
import { parseUnit } from "@/server/system/units";

const query = z.object({
  /** Continue after this entry (the last cursor from the logs endpoint) so nothing is missed or repeated. */
  cursor: z.string().regex(JOURNAL_CURSOR_RE).optional(),
  /** Without a cursor: how many recent entries to send first (default 0). */
  backlog: z.coerce.number().int().min(0).max(500).optional(),
});

/** Live journal for a service. Events: `entry` { time, priority, message, identifier, pid, cursor }, `end`. */
export const GET = route({ auth: "admin", query }, ({ req, params, query }) => {
  const unit = parseUnit(params.unit);
  return sse(req, (send, close) => {
    const stop = followJournal(
      unit,
      { afterCursor: query.cursor, backlog: query.backlog },
      (e) => send("entry", e),
      () => {
        send("end", {});
        close();
      },
    );
    return stop;
  });
});
