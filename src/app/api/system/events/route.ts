import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";

/** Lets the System page revalidate instead of polling. Events: `updates`, `services`. */
export const GET = route({ auth: "admin" }, ({ req }) =>
  sse(req, (send) => {
    const offs = [subscribe("system.updates", (d) => send("updates", d)), subscribe("system.services", (d) => send("services", d))];
    return () => offs.forEach((o) => o());
  }),
);
