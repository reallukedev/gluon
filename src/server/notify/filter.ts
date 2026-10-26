import { KIND_INFO, MEMBER_KINDS, type DeliveryEvent, type NotifyKind, type SubscriptionFilter } from "@/lib/alerts-types";

/**
 * Who wants what. Pure, so the rules can be tested without a database: findings map to a kind,
 * subscriptions list the kinds they want, and "only some apps" narrows the kinds that are about apps.
 */

export type Audience = "admin" | "member";

/** Finding kinds a household member may hear about (their apps being down, and back). */
export const MEMBER_FINDING_KINDS = new Set(["app.broken", "monitor.down"]);
export const REPORT_FINDING_KIND = "household.report";

/** Which notification kind a finding is. null = never notified (info). */
export function findingKind(f: { kind: string; severity: string }): NotifyKind | null {
  if (f.kind === REPORT_FINDING_KIND) return "reports";
  if (f.kind === "signin.new_device") return "signin.new_device";
  if (f.kind === "signin.throttled") return "signin.locked";
  if (f.severity === "fault") return "fault";
  if (f.severity === "attention") return "attention";
  return null;
}

/** The log's event column for a noticed event. */
export function eventOf(kind: NotifyKind): DeliveryEvent {
  if (kind.startsWith("gluon.") || kind.startsWith("app.")) return "update";
  if (kind.startsWith("signin.") || kind.startsWith("mfa.")) return "security";
  if (kind.startsWith("chat.")) return "chat";
  if (kind === "digest") return "digest";
  if (kind === "reports") return "report";
  if (kind === "resolved") return "resolved";
  return "problem";
}

const has = (f: Pick<SubscriptionFilter, "kinds">, k: NotifyKind) => f.kinds.includes(k);

function subjectOk(f: Pick<SubscriptionFilter, "subjects">, subject: string | null | undefined): boolean {
  if (f.subjects === "all") return true;
  return !!subject && f.subjects.includes(subject);
}

/** Does this subscription want this finding? `memberApps` = app ids a member can see (members only). */
export function wantsFinding(
  role: Audience,
  f: Pick<SubscriptionFilter, "kinds" | "subjects">,
  finding: { kind: string; severity: string; subject: string | null },
  memberApps: Set<string> | null,
): boolean {
  const kind = findingKind(finding);
  if (!kind || !has(f, kind)) return false;
  if (role !== "admin") {
    if (!MEMBER_FINDING_KINDS.has(finding.kind) || !finding.subject || !memberApps?.has(finding.subject)) return false;
    return subjectOk(f, finding.subject);
  }
  return KIND_INFO[kind].apps ? subjectOk(f, finding.subject) : true;
}

/** Does this subscription want a noticed event (an update, a sign-in, a chat join)? */
export function wantsEvent(role: Audience, f: Pick<SubscriptionFilter, "kinds" | "subjects">, ev: { kind: NotifyKind; subject?: string | null }, memberApps: Set<string> | null): boolean {
  if (!has(f, ev.kind)) return false;
  if (role !== "admin") {
    if (!MEMBER_KINDS.includes(ev.kind) || !KIND_INFO[ev.kind].apps) return false;
    if (!ev.subject || !memberApps?.has(ev.subject)) return false;
  }
  return KIND_INFO[ev.kind].apps ? subjectOk(f, ev.subject) : true;
}

/** Faults may break through quiet hours (when the person allows it); nothing else does. */
export function bypassesQuiet(kind: NotifyKind | null, f: Pick<SubscriptionFilter, "quiet">): boolean {
  return kind === "fault" && !!f.quiet?.bypassFaults;
}
