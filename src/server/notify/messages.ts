import "server-only";
import { one, now } from "../db";
import { publicBaseUrl, getSetting } from "../settings";
import { listOpen, type Finding } from "../findings";
import { listMonitorRows } from "../monitors/store";
import { uptimeAll } from "../monitors/stats";
import { listJoin, plural } from "@/lib/format";
import type { SubscriptionFilter } from "@/lib/alerts-types";

/**
 * What notifications say. Admins get the finding as written (title, cause, the fix); household
 * members get a calm version about their app, with no jargon.
 */

export interface Composed {
  title: string;
  body: string;
  link: string | null;
  linkLabel: string | null;
  severity: "fault" | "attention" | "info" | null;
}

const base = () => publicBaseUrl();
export const findingLink = (id: string) => `${base()}/status#${encodeURIComponent(id)}`;
const memberLink = () => (getSetting("householdCanSeeStatus") ? `${base()}/status` : `${base()}/`);

/** 90 s → "2 minutes", 5 h → "5 hours". */
export function humanSpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return plural(m, "minute");
  const h = Math.round(m / 60);
  if (h < 48) return plural(h, "hour");
  return plural(Math.round(h / 24), "day");
}

export function problemMessage(f: Finding, audience: "admin" | "member", appName: string | null, filter: SubscriptionFilter): Composed {
  if (audience === "member") {
    const name = appName ?? "One of your apps";
    return {
      title: `${name} isn't working right now`,
      body: `Gluon noticed and the admin has been told. You don't need to do anything${filter.resolved ? "; you'll get a message when it's back" : ""}.`,
      link: memberLink(),
      linkLabel: "Open Gluon",
      severity: f.severity,
    };
  }
  const parts: string[] = [];
  if (f.cause) parts.push(f.cause);
  if (f.remedy?.label) parts.push(f.remedy.action ? `Fix: ${f.remedy.label} (one tap in Gluon).` : `Next step: ${f.remedy.label}.`);
  return {
    title: f.title,
    body: parts.join("\n\n"),
    link: findingLink(f.id),
    linkLabel: f.remedy?.label ?? "Open in Gluon",
    severity: f.severity,
  };
}

export function resolvedMessage(
  f: { id: string; title: string; firstSeen: number; resolvedAt: number | null; severity: Finding["severity"] },
  audience: "admin" | "member",
  appName: string | null,
): Composed {
  const span = humanSpan((f.resolvedAt ?? now()) - f.firstSeen);
  if (audience === "member") {
    return {
      title: `${appName ?? "Your app"} is working again`,
      body: `It was out for about ${span}.`,
      link: memberLink(),
      linkLabel: "Open Gluon",
      severity: null,
    };
  }
  return {
    title: `Resolved: ${f.title}`,
    body: `Cleared after ${span}.`,
    link: findingLink(f.id),
    linkLabel: "Open in Gluon",
    severity: null,
  };
}

export function batchMessage(items: { title: string; severity: string | null }[], event: "problem" | "resolved"): Composed {
  const server = getSetting("serverName");
  const rank = (sev: string | null) => (sev === "fault" ? 0 : sev === "attention" ? 1 : 2);
  const sorted = [...items].sort((a, b) => rank(a.severity) - rank(b.severity));
  const shown = sorted.slice(0, 8).map((i) => `• ${i.title.replace(/^Resolved: /, "")}`);
  if (items.length > shown.length) shown.push(`…and ${items.length - shown.length} more`);
  const worst = items.some((i) => i.severity === "fault") ? "fault" : items.some((i) => i.severity === "attention") ? "attention" : null;
  return {
    title: event === "problem" ? `${plural(items.length, "problem")} on ${server}` : `${plural(items.length, "problem")} cleared on ${server}`,
    body: shown.join("\n"),
    link: `${base()}/status`,
    linkLabel: "Open Gluon",
    severity: event === "problem" ? worst : null,
  };
}

export function reportReplyMessage(r: { id: string; appName: string | null; reply: string }, adminName: string): Composed {
  return {
    title: `${adminName} replied about ${r.appName ?? "your report"}`,
    body: r.reply,
    link: `${base()}/status#report-${encodeURIComponent(r.id)}`,
    linkLabel: "See your reports",
    severity: null,
  };
}

// ---------------------------------------------------------------- daily digest

export function digestMessage(): Composed {
  const t = now();
  const day = t - 86_400_000;
  const server = getSetting("serverName");
  const open = listOpen();
  const lines: string[] = [];

  if (open.length) {
    lines.push("Needs you:");
    for (const f of open.slice(0, 6)) lines.push(`• ${f.title} (for ${humanSpan(t - f.firstSeen)})`);
    if (open.length > 6) lines.push(`…and ${open.length - 6} more`);
  } else {
    lines.push("Nothing needs you.");
  }

  const monitors = listMonitorRows().filter((m) => m.enabled);
  const uptime = uptimeAll();
  const withData = monitors.map((m) => ({ name: m.name, u: uptime.get(m.id)?.h24 ?? null })).filter((x): x is { name: string; u: number } => x.u !== null);
  if (withData.length) {
    const avg = withData.reduce((a, x) => a + x.u, 0) / withData.length;
    const worst = withData.filter((x) => x.u < 99.95).sort((a, b) => a.u - b.u).slice(0, 3);
    lines.push("");
    lines.push(`Uptime, last 24 hours: ${avg >= 99.995 ? "100" : avg.toFixed(2)}% across ${plural(withData.length, "monitor")}.`);
    if (worst.length) lines.push(`Lowest: ${listJoin(worst.map((w) => `${w.name} ${w.u.toFixed(1)}%`))}.`);
  }

  const opened = one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE first_seen > ? AND severity != 'info'", day)?.n ?? 0;
  const cleared = one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE resolved_at > ? AND severity != 'info'", day)?.n ?? 0;
  const failedLogins = one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE at > ? AND action = 'auth.login' AND outcome = 'failed'", day)?.n ?? 0;
  const reports = one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE created_at > ?", day)?.n ?? 0;
  const notable: string[] = [];
  if (opened) notable.push(`${plural(opened, "new problem")}`);
  if (cleared) notable.push(`${cleared} cleared`);
  if (reports) notable.push(`${plural(reports, "problem report")} from the household`);
  if (failedLogins) notable.push(`${plural(failedLogins, "failed sign-in")}`);
  if (notable.length) {
    lines.push("");
    lines.push(`Last 24 hours: ${listJoin(notable)}.`);
  }

  return {
    title: open.length ? `${server}: ${plural(open.length, "thing")} need${open.length === 1 ? "s" : ""} you` : `${server}: all good`,
    body: lines.join("\n"),
    link: `${base()}/status`,
    linkLabel: "Open Gluon",
    severity: null,
  };
}
