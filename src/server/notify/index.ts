import "server-only";
import { onStart, every } from "../jobs";
import { subscribe } from "../events";
import { registerSearch } from "../search";
import { followUps, kick, tick, TICK_MS } from "./dispatcher";
import { allChannels, canSee } from "./channels";

/** Side-effect module: the notification dispatcher and channel search. */

onStart("notify", () => {
  // Wait for the alert engine's first pass (it starts after 8 s) so a restart doesn't send a burst of
  // half-evaluated findings.
  setTimeout(() => {
    every(TICK_MS, () => tick(), { immediate: true });
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

registerSearch((user, q) => {
  const term = q.toLowerCase();
  const items = allChannels()
    .filter((c) => canSee(user, c) && c.name.toLowerCase().includes(term))
    .slice(0, 5)
    .map((c) => ({
      id: `channel:${c.id}`,
      label: c.name,
      hint: `Notification channel · ${c.kind}`,
      href: user.role === "admin" ? `/alerts?tab=channels&channel=${encodeURIComponent(c.id)}` : `/settings/notifications`,
    }));
  return { name: "Notifications", items };
});
