import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch } from "../search";
import { rank } from "@/lib/search-match";
import { alertsHref } from "@/lib/settings-links";
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

registerSearch({
  key: "monitors",
  name: "Monitors",
  priority: 60,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items = rank(ctx.query, listMonitorRows(), (m) => ({ label: m.name, keywords: `monitor uptime check ${m.kind} ${m.target}` }))
      .slice(0, 6)
      .map(({ item: m, score }) => ({
        id: `monitor:${m.id}`,
        label: m.name,
        hint: m.source === "auto" ? `Monitor · ${m.target}` : `Monitor · ${m.kind.toUpperCase()} ${m.target}`,
        icon: "monitor",
        href: alertsHref("watching", { monitor: m.id }),
        score,
      }));
    return { name: "Monitors", items };
  },
});
