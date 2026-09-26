import "server-only";
import { onStart } from "../jobs";
import { registerSearch } from "../search";
import { listApps } from "../docker/apps";
import { ensureCaddyFollower } from "./caddy-log";

/**
 * Diagnostics domain. Live samplers (connections, processes) only run while someone is watching;
 * the Caddy request feed runs all the time so the request stats cover more than the open tab.
 */
onStart("caddy-request-feed", () => {
  ensureCaddyFollower();
});

/** ⌘K: "checkup", "slow", "safe"… offer to run a checkup; an app's name offers "Check why … won't open". */
const CHECKUPS = [
  { id: "full", label: "Run a checkup", hint: "Check the whole server for problems", words: "checkup check up health doctor diagnose diagnostics test problems broken everything" },
  { id: "internet", label: "Check why the internet feels slow", hint: "Latency, DNS, speed and delay under load", words: "internet slow speed latency ping dns bufferbloat wifi connection" },
  { id: "server", label: "Check why the server feels slow", hint: "Processor, memory, disks and the busiest programs", words: "server slow sluggish cpu load memory busy lag" },
  { id: "space", label: "Check what's using the space", hint: "Full drives, biggest folders, what can be freed", words: "space full disk storage room free cleanup" },
  { id: "safety", label: "Check whether the server is safe on the internet", hint: "Exposure, logins, SSH and two-step sign-in", words: "safe security secure exposed hack ssh internet login two-step 2fa" },
];

registerSearch(async (user, q) => {
  if (user.role !== "admin") return null;
  const term = q.toLowerCase().trim();
  const items: { id: string; label: string; hint?: string; icon?: string; href?: string }[] = [];
  for (const c of CHECKUPS) {
    if (c.label.toLowerCase().includes(term) || c.words.split(" ").some((w) => w.startsWith(term) || (term.length >= 4 && term.includes(w)))) {
      items.push({ id: `checkup:${c.id}`, label: c.label, hint: c.hint, icon: "diagnostics", href: `/diagnostics?start=${c.id}` });
    }
  }
  if (term.length >= 3) {
    const apps = await listApps().catch(() => []);
    const hits = apps.filter((x) => x.name.toLowerCase().includes(term) && (x.webPort || x.routes.length)).slice(0, 3);
    for (const a of hits) {
      const twin = hits.some((b) => b !== a && b.name === a.name);
      items.push({ id: `checkup:app:${a.id}`, label: `Check why ${a.name} won't open`, hint: twin ? `Checkup · ${a.id}` : "Checkup", icon: "diagnostics", href: `/diagnostics?start=app&target=${encodeURIComponent(a.id)}` });
    }
  }
  return items.length ? { name: "Checkups", items: items.slice(0, 6) } : null;
});
