import type { ActivityItem } from "@/lib/people-types";
import { alertsHref, peopleHref } from "@/lib/settings-links";

export interface Names {
  people: Map<string, string>;
  apps: Map<string, string>;
}

/** Where an entry's target lives in Gluon, and what to call it. Null when there's nowhere useful to go. */
export function targetLink(e: ActivityItem, names: Names): { href: string | null; label: string } | null {
  const t = e.target;
  if (!t) return null;
  const a = e.action;
  const app = names.apps.get(t);
  const person = names.people.get(t);

  if (a.startsWith("monitor.")) return { href: alertsHref("watching", { monitor: t }), label: "the monitor" };
  if (a.startsWith("channel.")) return { href: alertsHref("notifications", { channel: t }), label: "the channel" };
  if (a.startsWith("people.folder") || a.startsWith("files.")) return { href: t.startsWith("/") ? `/files?path=${encodeURIComponent(t)}` : "/files", label: t };
  if (a.startsWith("people.invite")) return { href: peopleHref(), label: "the invite" };
  if (person) return { href: peopleHref({ person: t }), label: person };
  if (a.startsWith("household.report")) return { href: peopleHref({ tab: "reports" }), label: app ?? "the report" };
  if (a.startsWith("people.")) return { href: peopleHref(), label: app ?? t };
  if (app || a.startsWith("app.") || a.startsWith("apps.") || a.startsWith("stack.") || a.startsWith("container.") || a.startsWith("finding.app.")) {
    return { href: `/apps/${encodeURIComponent(t)}`, label: app ?? t };
  }
  if (a.startsWith("finding.disk") || a.startsWith("finding.storage") || a.startsWith("storage.")) return { href: "/storage", label: t };
  if (a.startsWith("finding.host") || a.startsWith("system.") || a.startsWith("finding.system")) return { href: "/system", label: t === "cpu" ? "the processor" : t };
  if (a.startsWith("network.") || a.startsWith("route.") || a.startsWith("finding.network") || a.startsWith("finding.cert")) return { href: "/network", label: t };
  if (t.startsWith("/")) return { href: `/files?path=${encodeURIComponent(t)}`, label: t };
  return { href: null, label: t };
}

export type Outcome = { kind: "failed" | "problem" | "cleared" | "ok"; label: string };

/** Plain words for how it went. System "problem found" entries are stored as failed; say what they are. */
export function outcomeOf(e: ActivityItem): Outcome {
  const finding = e.action.startsWith("finding.");
  if (finding && e.action.endsWith(".resolved")) return { kind: "cleared", label: "Cleared" };
  if (e.outcome === "failed") {
    if (finding) return { kind: "problem", label: "Problem found" };
    if (e.kind === "system") return { kind: "problem", label: "Went wrong" };
    return { kind: "failed", label: "Failed" };
  }
  return { kind: "ok", label: "Done" };
}

/** Entries that say the same thing in a row (five sign-ins in an hour) read as one line. */
export function sameRun(a: ActivityItem, b: ActivityItem): boolean {
  return a.kind === b.kind && a.userId === b.userId && a.action === b.action && a.target === b.target && a.outcome === b.outcome && a.summary === b.summary && Math.abs(a.at - b.at) < 6 * 3_600_000;
}
