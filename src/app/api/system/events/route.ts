import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";

/**
 * Change notifications for the System page, so it can revalidate instead of polling.
 * Events: `updates` { change, runId?, outcome? }, `services` { unit, action, ok }.
 */
export const GET = route({ auth: "admin" }, ({ req }) =>
  sse(req, (send) => {
    const offs = [subscribe("system.updates", (d) => send("updates", d)), subscribe("system.services", (d) => send("services", d))];
    return () => offs.forEach((o) => o());
  }),
);
