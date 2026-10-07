import "server-only";
import { onStart, every } from "../jobs";
import { subscribe } from "../events";
import { registerSearch } from "../search";
import { rank } from "@/lib/search-match";
import { alertsHref } from "@/lib/settings-links";
import { followUps, kick, tick, TICK_MS } from "./dispatcher";
import { allChannels, canSee } from "./channels";
import { runWatchers } from "./watchers";

/** Side-effect module: the notification dispatcher and channel search. */

onStart("notify", () => {
  // Wait for the alert engine's first pass (it starts after 8 s) so a restart doesn't send a burst of
  // half-evaluated findings.
  setTimeout(() => {
    every(TICK_MS, () => tick(), { immediate: true });
    // Not awaited: a slow registry or chat server mustn't hold up the next look at the activity log.
    every(30_000, () => void runWatchers(), { immediate: true });
    subscribe("findings", onFinding);
  }, 20_000);
  function onFinding(data: unknown) {
    const change = (data as { change?: string } | null)?.change;
    if (change === "resolved" || change === "dismissed") {
      try {
        followUps();
      } catch (e) {
        console.error("[gluon] notify follow-up failed", e);
      }
    }
    if (change === "opened" || change === "resolved" || change === "dismissed" || change === "snoozed" || change === "restored") kick();
  }
});

registerSearch({
  key: "channels",
  name: "Notifications",
  priority: 62,
  run(user, _q, ctx) {
    const visible = allChannels().filter((c) => canSee(user, c));
    const items = rank(ctx.query, visible, (c) => ({ label: c.name, keywords: `notification channel alert ${c.kind}` }))
      .slice(0, 5)
      .map(({ item: c, score }) => ({
        id: `channel:${c.id}`,
        label: c.name,
        hint: `Notification channel · ${c.kind}`,
        icon: "bell",
        href: user.role === "admin" ? alertsHref("notifications", { channel: c.id }) : `/settings/notifications`,
        score,
      }));
    return { name: "Notifications", items };
  },
});
