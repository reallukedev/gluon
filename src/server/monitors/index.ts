import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch } from "../search";
import { listMonitorRows } from "./store";
import { schedule } from "./runner";
import { syncAutoMonitors } from "./auto";
import { pruneChecks } from "./stats";

/** Side-effect module: uptime monitor scheduler, auto-monitor sync, pruning and search. */

onStart("monitors", () => {
  // Let Docker and the routes file settle before the first sync, then check continuously.
  setTimeout(() => {
    every(60_000, () => syncAutoMonitors(), { immediate: true });
    every(2_000, () => schedule());
  }, 10_000);
  every(60 * 60_000, () => pruneChecks(listMonitorRows().map((m) => m.id)), { immediate: false });
});

registerSearch((user, q) => {
  if (user.role !== "admin") return null;
  const term = q.toLowerCase();
  const items = listMonitorRows()
    .filter((m) => m.name.toLowerCase().includes(term) || m.target.toLowerCase().includes(term))
    .slice(0, 6)
    .map((m) => ({
      id: `monitor:${m.id}`,
      label: m.name,
      hint: m.source === "auto" ? `Monitor · ${m.target}` : `Monitor · ${m.kind.toUpperCase()} ${m.target}`,
      href: `/alerts?tab=monitors&monitor=${encodeURIComponent(m.id)}`,
    }));
  return { name: "Monitors", items };
});
