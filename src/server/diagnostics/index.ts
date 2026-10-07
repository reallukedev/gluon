import "server-only";
import { onStart } from "../jobs";
import { registerSearch, type ProviderItem } from "../search";
import { matchScore, prepare, rank, splitVerb } from "@/lib/search-match";
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

/** Words that ask for a checkup of an app ("why won't jellyfin open"). */
const CHECK_VERBS: Record<string, string> = { check: "check", why: "check", diagnose: "check", broken: "check", won: "check", wont: "check", t: "check", working: "check", load: "check", loading: "check" };

registerSearch({
  key: "checkups",
  name: "Checkups",
  priority: 55,
  async run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items: ProviderItem[] = [];
    for (const c of CHECKUPS) {
      const score = matchScore(ctx.query, { label: c.label, keywords: c.words, hint: c.hint });
      if (score) items.push({ id: `checkup:${c.id}`, label: c.label, hint: c.hint, icon: "diagnostics", href: `/diagnostics?start=${c.id}`, score });
    }
    if (ctx.query.compact.length >= 3) {
      // "jellyfin" or "why won't jellyfin open" offers a checkup for that app. Asked for with a verb
      // ("check jellyfin") and only one app fits, the checkup is the best match.
      const split = splitVerb(ctx.query, CHECK_VERBS);
      const verb = split.verb;
      // "open" only reads as part of a question here ("why won't X open"); alone it means Open X.
      const words = split.rest.folded.split(" ").filter((w) => !verb || w !== "open");
      const rest = words.length ? prepare(words.join(" ")) : split.rest;
      const apps = await listApps().catch(() => []);
      const hits = rank(rest, apps.filter((x) => x.webPort || x.routes.length), (a) => ({ label: a.name }), 0.78).slice(0, 3);
      const unique = hits.length === 1 || (hits.length > 1 && hits[1]!.score < hits[0]!.score - 0.02);
      hits.forEach(({ item: a, score }, i) => {
        const twin = hits.some((b) => b.item !== a && b.item.name === a.name);
        const asked = verb && unique && i === 0;
        items.push({ id: `checkup:app:${a.id}`, label: `Check why ${a.name} won't open`, hint: twin ? `Checkup · ${a.id}` : "Checkup", icon: "diagnostics", href: `/diagnostics?start=app&target=${encodeURIComponent(a.id)}`, score: asked ? 1 : score * 0.8, final: !!asked });
      });
    }
    return { name: "Checkups", items: items.slice(0, 6) };
  },
});
