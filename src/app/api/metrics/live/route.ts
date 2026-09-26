import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { containerHistory, hostHistory } from "@/server/metrics/sampler";

/** Live host + container samples. Starts with the last few minutes so charts aren't empty. */
export const GET = route({ auth: "user" }, ({ req, user }) =>
  sse(req, (send) => {
    // Keep the first paint light: per-core detail only on the newest sample, and a short container window.
    const host = hostHistory().map((h, i, arr) => (i === arr.length - 1 ? h : { ...h, cores: [], net: { ...h.net, ifaces: {} }, disk: { ...h.disk, devices: {} } }));
    send("snapshot", { host, containers: user.role === "admin" ? containerHistory().slice(-24) : [] });
    const offs = [subscribe("metrics.host", (d) => send("host", d))];
    if (user.role === "admin") offs.push(subscribe("metrics.containers", (d) => send("containers", d)));
    return () => offs.forEach((o) => o());
  }),
);
