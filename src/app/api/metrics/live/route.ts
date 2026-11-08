import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { containerHistory, hostHistory, type HostSample } from "@/server/metrics/sampler";
import { getSetting } from "@/server/settings";

/** Live host + container samples. Starts with the last few minutes so charts aren't empty. */
export const GET = route({ auth: "user" }, ({ req, user }) =>
  sse(req, (send) => {
    const admin = user.role === "admin";
    // Same rule as the history endpoint: members see machine-wide numbers only when the household may see status.
    const hostAllowed = admin || getSetting("householdCanSeeStatus");
    // Members get machine-wide totals only, never device or interface names.
    const forMember = (h: HostSample): HostSample => ({ ...h, net: { ...h.net, ifaces: {} }, disk: { ...h.disk, devices: {} } });
    // Keep the first paint light: per-core detail only on the newest sample, and a short container window.
    const host = hostAllowed ? hostHistory().map((h, i, arr) => (i === arr.length - 1 ? h : { ...h, cores: [], net: { ...h.net, ifaces: {} }, disk: { ...h.disk, devices: {} } })) : [];
    send("snapshot", { host: admin ? host : host.map(forMember), containers: admin ? containerHistory().slice(-24) : [] });
    const offs: (() => void)[] = [];
    if (hostAllowed) offs.push(subscribe("metrics.host", (d) => send("host", admin ? d : forMember(d as HostSample))));
    if (admin) offs.push(subscribe("metrics.containers", (d) => send("containers", d)));
    return () => offs.forEach((o) => o());
  }),
);
