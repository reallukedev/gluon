import { z } from "zod";
import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { ensureCaddyFollower, feedState, recentNotices, recentRequests, requestStats } from "@/server/diagnostics/caddy-log";
import type { RequestEntry } from "@/lib/diagnostics-types";

const query = z.object({
  /** Include Gluon's/Domains' health checks and requests from containers on this machine. */
  internal: z.enum(["0", "1"]).default("0"),
  window: z.coerce.number().int().min(1).max(60).default(15),
  limit: z.coerce.number().int().min(10).max(1000).default(300),
});

/**
 * Live public requests through Caddy. Events:
 *  snapshot { state: RequestFeedState, requests: RequestEntry[], notices: CaddyNotice[], stats: RequestStats }
 *  requests RequestEntry[] (batched every ~0.5 s)
 *  notice   CaddyNotice (certificate activity, warnings, errors)
 *  stats    RequestStats (every 5 s)
 *  state    RequestFeedState (when it changes)
 */
export const GET = route({ auth: "admin", query }, ({ req, query }) =>
  sse(req, (send) => {
    ensureCaddyFollower();
    const includeInternal = query.internal === "1";
    let lastState = JSON.stringify(feedState());
    send("snapshot", { state: feedState(), requests: recentRequests(query.limit, includeInternal), notices: recentNotices(50), stats: requestStats(query.window) });
    let batch: RequestEntry[] = [];
    const flush = setInterval(() => {
      if (!batch.length) return;
      send("requests", batch);
      batch = [];
    }, 500);
    const stats = setInterval(() => {
      send("stats", requestStats(query.window));
      const s = JSON.stringify(feedState());
      if (s !== lastState) {
        lastState = s;
        send("state", feedState());
      }
    }, 5000);
    const offs = [
      subscribe("caddy.request", (d) => {
        const e = d as RequestEntry;
        if (!includeInternal && e.internal) return;
        batch.push(e);
        if (batch.length > 500) batch = batch.slice(-500);
      }),
      subscribe("caddy.notice", (d) => send("notice", d)),
    ];
    return () => {
      clearInterval(flush);
      clearInterval(stats);
      offs.forEach((o) => o());
    };
  }),
);
