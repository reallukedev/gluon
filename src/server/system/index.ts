import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch, type ProviderItem } from "../search";
import { matchScore, rank } from "@/lib/search-match";
import { AppError } from "../errors";
import { refreshHistory, refreshLists } from "./apt";
import { pruneRuns, resumeRuns } from "./apt-runner";
import { listServices } from "./services";
import "./checks";

/**
 * System section: registers background jobs (daily package-list refresh, resuming update runs),
 * checks and remedies (./checks) and the ⌘K search provider.
 */

const HOUR = 3_600_000;

/** Refresh package lists once a day; after a failure, retry every 3 hours. */
async function dailyRefresh() {
  const h = refreshHistory();
  const t = Date.now();
  const due = !h.lastSuccessAt || t - h.lastSuccessAt > 24 * HOUR;
  const gap = h.ok === false ? 3 * HOUR : 24 * HOUR;
  if (!due || (h.at && t - h.at < gap)) return;
  try {
    await refreshLists({ reason: h.ok === false ? "retry" : "daily" });
  } catch (e) {
    // Someone else is using apt (unattended-upgrades, an install): try again next hour.
    if (!(e instanceof AppError)) throw e;
  }
}

onStart("system", () => {
  resumeRuns();
  pruneRuns();
  // Leave the first minutes after boot to the apps.
  setTimeout(() => {
    void dailyRefresh();
    every(HOUR, dailyRefresh);
  }, 2 * 60_000).unref?.();
  every(24 * HOUR, pruneRuns);
});

// ---------------------------------------------------------------- search

const PLACES: { id: string; label: string; hint: string; keywords: string; href: string }[] = [
  { id: "updates", label: "Updates", hint: "System · install package updates", keywords: "upgrade apt packages security patches debian", href: "/system?tab=updates" },
  { id: "power", label: "Restart or shut down", hint: "System · power", keywords: "reboot shutdown power off turn off restart server", href: "/system?tab=power" },
  { id: "identity", label: "Name, time and timezone", hint: "System · overview", keywords: "hostname rename clock time zone ntp date", href: "/system#identity" },
  { id: "sign-ins", label: "Who's signed in", hint: "System · SSH sessions and sign-in attempts", keywords: "ssh login log in sessions connected brute force failed attempts", href: "/system?tab=sign-ins" },
  { id: "services", label: "Services", hint: "System · start, stop, logs", keywords: "daemon systemd units", href: "/system?tab=services" },
  { id: "about", label: "About this server", hint: "System · overview", keywords: "kernel os debian cpu hardware uptime memory ram temperature sensors", href: "/system" },
];

registerSearch({
  key: "system",
  name: "System",
  priority: 45,
  async run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items: ProviderItem[] = [];
    for (const p of PLACES) {
      const score = matchScore(ctx.query, { label: p.label, keywords: p.keywords, hint: p.hint });
      if (score >= 0.5) items.push({ id: `system:${p.id}`, label: p.label, hint: p.hint, icon: "system", href: p.href, score });
    }
    const services = await listServices({ maxAgeMs: 60_000 }).catch(() => []);
    const matches = rank(
      ctx.query,
      services.filter((s) => s.load !== "not-found"),
      (s) => ({ label: s.name, keywords: `${s.unit.replace(/\.service$/, "")} service`, hint: s.description }),
      0.5,
    ).sort((a, b) => b.score - a.score || Number(b.item.important) - Number(a.item.important));
    for (const { item: s, score } of matches.slice(0, 8)) {
      const state = s.active === "active" ? (s.sub === "running" ? "running" : "active") : s.active === "failed" ? "failed" : "stopped";
      items.push({ id: `service:${s.unit}`, label: s.name, hint: `${s.unit.replace(/\.service$/, "")} · ${state}`, icon: "service", href: `/system?tab=services&unit=${encodeURIComponent(s.unit)}`, score: score * 0.9 });
    }
    return { name: "System", items };
  },
});

export {};
