import "server-only";
import { currentAnnouncements } from "./people/household";
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
  /** Docker didn't answer, so `apps` is empty because Gluon couldn't look, not because there are none. */
  appsUnavailable: boolean;
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

function dockerDownVerdict(findings: Finding[], forMember: boolean): StatusPayload["verdict"] {
  if (forMember) return { tone: "fault", headline: "Gluon can't see the apps right now.", detail: "The part of the server that runs them isn't answering. The people who look after the server can see this too." };
  const others = findings.length;
  return {
    tone: "fault",
    headline: "Docker isn't answering.",
    detail: `Gluon can't see any apps until it does, so this page can't say whether they're running.${others ? ` ${others === 1 ? "1 other thing needs" : `${others} other things need`} you too.` : ""} It may be restarting; if it stays like this, restart Docker from System → Services.`,
  };
}

function verdictFor(findings: Finding[], apps: StatusApp[], forMember: boolean): StatusPayload["verdict"] {
  const faults = findings.filter((f) => f.severity === "fault");
  const attention = findings.filter((f) => f.severity === "attention");
  const down = apps.filter((a) => a.line === "unhealthy" || a.line === "stopped");
  if (forMember) {
    if (!apps.length) return { tone: "ok", headline: "The server is up.", detail: "No apps have been shared with you yet. Ask whoever runs it to share the ones you use." };
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
  // Docker restarting (or its socket missing) mustn't take Status down with it: Status is where you'd
  // go to find out. The page says what it couldn't see instead.
  let apps: StatusApp[] = [];
  let appsUnavailable = false;
  try {
    apps = (isAdmin ? (await listApps()).filter((a) => !a.hidden) : await appsForMember(user.id)).map(slim);
  } catch {
    appsUnavailable = true;
  }
  const findings = isAdmin ? listOpen() : [];
  const h = latestHost();
  return {
    verdict: appsUnavailable ? dockerDownVerdict(findings, !isAdmin) : verdictFor(findings, apps, !isAdmin),
    appsUnavailable,
    findings,
    apps,
    filesystems: isAdmin ? filesystems() : [],
    uptime: h?.uptime ?? null,
    recent: isAdmin ? listActivity({ limit: 8 }) : [],
    announcements: (await currentAnnouncements(user)).map(({ id, message, app_id }) => ({ id, message, app_id })),
    checkedAt: Date.now(),
  };
}
