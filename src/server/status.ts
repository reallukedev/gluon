import "server-only";
import { listApps, appsForMember, type AppSummary } from "./docker/apps";
import { listOpen, type Finding } from "./findings";
import { filesystems, latestHost, type FsUsage } from "./metrics/sampler";
import { listActivity, type ActivityEntry } from "./audit";
import type { User } from "./auth/users";
import { listJoin } from "@/lib/format";
import { all, now } from "./db";

export interface StatusApp {
  id: string;
  name: string;
  icon: string | null;
  line: AppSummary["line"];
  summary: string;
  containers: { name: string; service: string | null; line: AppSummary["line"] }[];
  urls: AppSummary["urls"];
  household: boolean;
  source: AppSummary["source"];
  copyOf: AppSummary["copyOf"];
}

export interface StatusPayload {
  verdict: { tone: "ok" | "attention" | "fault"; headline: string; detail: string };
  findings: Finding[];
  apps: StatusApp[];
  filesystems: FsUsage[];
  uptime: number | null;
  recent: ActivityEntry[];
  announcements: { id: string; message: string; app_id: string | null }[];
  checkedAt: number;
}

const slim = (a: AppSummary): StatusApp => ({
  id: a.id,
  name: a.name,
  icon: a.icon,
  line: a.line,
  summary: a.summary,
  containers: a.containers.map((c) => ({ name: c.name, service: c.service, line: c.line })),
  urls: a.urls,
  household: a.household,
  source: a.source,
  copyOf: a.copyOf,
});

function verdictFor(findings: Finding[], apps: StatusApp[], forMember: boolean): StatusPayload["verdict"] {
  const faults = findings.filter((f) => f.severity === "fault");
  const attention = findings.filter((f) => f.severity === "attention");
  const down = apps.filter((a) => a.line === "unhealthy" || a.line === "stopped");
  if (forMember) {
    if (down.length) {
      return { tone: "fault", headline: `${listJoin(down.map((a) => a.name))} ${down.length === 1 ? "isn't" : "aren't"} working right now.`, detail: "The people who look after the server have been told." };
    }
    return { tone: "ok", headline: "Everything's working.", detail: "All your apps are up." };
  }
  if (faults.length) {
    const lead = faults[0]!.title.replace(/\.$/, "");
    return {
      tone: "fault",
      headline: faults.length === 1 ? `${lead}.` : `${faults.length} things are broken.`,
      detail: attention.length ? `${attention.length} more ${attention.length === 1 ? "thing needs" : "things need"} you after that.` : "Everything else is running.",
    };
  }
  if (attention.length) {
    return {
      tone: "attention",
      headline: `Everything is running. ${attention.length === 1 ? "1 thing needs" : `${attention.length} things need`} you.`,
      detail: attention.some((f) => (f.detail as { daysToFull?: number } | null)?.daysToFull) ? "One of them will become a problem soon." : "None of them are urgent yet.",
    };
  }
  return { tone: "ok", headline: "Everything is running.", detail: "Nothing needs you." };
}

export async function statusFor(user: User): Promise<StatusPayload> {
  const isAdmin = user.role === "admin";
  const apps = (isAdmin ? (await listApps()).filter((a) => !a.hidden) : await appsForMember(user.id)).map(slim);
  const findings = isAdmin ? listOpen() : [];
  const h = latestHost();
  return {
    verdict: verdictFor(findings, apps, !isAdmin),
    findings,
    apps,
    filesystems: isAdmin ? filesystems() : [],
    uptime: h?.uptime ?? null,
    recent: isAdmin ? listActivity({ limit: 8 }) : [],
    announcements: all<{ id: string; message: string; app_id: string | null }>(
      "SELECT id, message, app_id FROM announcements WHERE until IS NULL OR until > ? ORDER BY created_at DESC",
      now(),
    ),
    checkedAt: Date.now(),
  };
}
