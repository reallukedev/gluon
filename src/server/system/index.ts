import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch } from "../search";
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

const PLACES: { keys: RegExp; label: string; hint: string; href: string }[] = [
  {
    keys: /^(upd|upg|apt|pack|secur|patch)/,
    label: "Updates",
    hint: "System · install package updates",
    href: "/system?tab=updates",
  },
  {
    keys: /^(rest|reb|shut|power|turn off)/,
    label: "Restart or shut down",
    hint: "System · power",
    href: "/system?tab=power",
  },
  {
    keys: /^(host|name|rename|time|clock|zone|ntp)/,
    label: "Name, time and timezone",
    hint: "System · overview",
    href: "/system#identity",
  },
  {
    keys: /^(ssh|sign|login|log in|who|session|connect|brute|fail)/,
    label: "Who's signed in",
    hint: "System · SSH sessions and sign-in attempts",
    href: "/system?tab=sign-ins",
  },
  {
    keys: /^(serv|daemon|systemd|unit)/,
    label: "Services",
    hint: "System · start, stop, logs",
    href: "/system?tab=services",
  },
  {
    keys: /^(kern|os|debian|cpu|hard|about|uptime|mem|ram|temp)/,
    label: "About this server",
    hint: "System · overview",
    href: "/system",
  },
];

registerSearch(async (user, q) => {
  if (user.role !== "admin") return null;
  const term = q.toLowerCase();
  const items: { id: string; label: string; hint?: string; href?: string }[] = [];
  for (const p of PLACES)
    if (p.keys.test(term))
      items.push({
        id: `system:${p.href}`,
        label: p.label,
        hint: p.hint,
        href: p.href,
      });

  const services = await listServices({ maxAgeMs: 60_000 }).catch(() => []);
  const matches = services
    .filter((s) => s.load !== "not-found")
    .map((s) => {
      const unit = s.unit.toLowerCase();
      const score = unit.startsWith(term)
        ? 0
        : s.name.toLowerCase().startsWith(term)
          ? 1
          : unit.includes(term)
            ? 2
            : s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term)
              ? 3
              : -1;
      return { s, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || Number(b.s.important) - Number(a.s.important))
    .slice(0, 8);
  for (const { s } of matches) {
    const state = s.active === "active" ? (s.sub === "running" ? "running" : "active") : s.active === "failed" ? "failed" : "stopped";
    items.push({
      id: `service:${s.unit}`,
      label: s.name,
      hint: `${s.unit.replace(/\.service$/, "")} · ${state}`,
      href: `/system?tab=services&unit=${encodeURIComponent(s.unit)}`,
    });
  }
  return { name: "System", items };
});

export {};
