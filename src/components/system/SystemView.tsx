"use client";
import * as React from "react";
import type { LiveLogins, MemoryBreakdown, PowerStatus, ServiceInfo, SystemOverview, UpdatesStatus } from "@/lib/system-types";
import { useApi, useStream, type ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { OverviewTab, OverviewSkeleton } from "./OverviewTab";
import { UpdatesTab, UpdatesSkeleton } from "./UpdatesTab";
import { ServicesTab, ServicesSkeleton } from "./ServicesTab";
import { PowerTab, PowerSkeleton } from "./PowerTab";
import { SignInsTab, SignInsSkeleton } from "./SignInsTab";
import { peopleList } from "./loginWords";
import { hostFailure } from "./hostFailure";
import s from "./system.module.css";

export type SystemTab = "overview" | "updates" | "services" | "sign-ins" | "power";

/** The server's reads, still on their way: each part of the page waits only for its own. */
export interface SystemInitial {
  updates: Promise<UpdatesStatus | undefined>;
  services: Promise<{ services: ServiceInfo[] } | undefined>;
  overview?: Promise<SystemOverview | undefined>;
  memory?: Promise<MemoryBreakdown | undefined>;
  power?: Promise<PowerStatus | undefined>;
  logins?: Promise<LiveLogins | undefined>;
}

const DAY = 86_400_000;

/** Security fixes waiting more than 3 days, or anything waiting more than 30, is "needs you". */
export function updatesOverdue(u: UpdatesStatus | undefined): boolean {
  if (!u) return false;
  const t = Date.now();
  return (!!u.oldestSecurityAt && u.counts.security > 0 && t - u.oldestSecurityAt > 3 * DAY) || (!!u.oldestPendingAt && t - u.oldestPendingAt > 30 * DAY);
}

/** The summary when updates or services couldn't be read (or are still loading). */
function unreadSummary(updatesError: ApiError | null, servicesError: ApiError | null): string {
  const failed = [updatesError && "updates", servicesError && "services"].filter(Boolean) as string[];
  if (!failed.length) return "Checking updates and services.";
  const list = failed.join(" and ");
  const missing = [updatesError, servicesError].every((e) => !e || hostFailure(e).kind === "missing");
  if (missing) return `${list[0]!.toUpperCase()}${list.slice(1)} ${failed.length > 1 ? "aren't" : "isn't"} available on this server.`;
  return `Couldn't check ${list}.`;
}

// The header and the tab below read the same SWR keys at the same pace, so their polls coincide.
const useUpdates = (fallbackData: UpdatesStatus | undefined) => useApi<UpdatesStatus>("/api/system/updates", { refresh: 60_000, fallbackData });
const useServices = (tab: SystemTab, fallbackData: { services: ServiceInfo[] } | undefined) =>
  useApi<{ services: ServiceInfo[] }>("/api/system/services", { refresh: tab === "services" ? 10_000 : 30_000, fallbackData });
const useLogins = (tab: SystemTab, fallbackData: LiveLogins | undefined) => useApi<LiveLogins>("/api/system/logins", { refresh: tab === "sign-ins" ? 5000 : 30_000, fallbackData });

export function SystemView({ tab, unit, initial }: { tab: SystemTab; unit: string | null; initial: SystemInitial }) {
  return (
    <Page>
      <React.Suspense fallback={<SystemHead tab={tab} summary={<Skeleton width="min(380px, 80%)" height={12} />} />}>
        <SystemHeadLive tab={tab} initial={initial} />
      </React.Suspense>
      <div className={s.tabBody}>
        {tab === "overview" && (
          <React.Suspense fallback={<OverviewSkeleton />}>
            <OverviewBody initial={initial} />
          </React.Suspense>
        )}
        {tab === "updates" && (
          <React.Suspense fallback={<UpdatesSkeleton />}>
            <UpdatesBody initial={initial} />
          </React.Suspense>
        )}
        {tab === "services" && (
          <React.Suspense fallback={<ServicesSkeleton />}>
            <ServicesBody initial={initial} unit={unit} />
          </React.Suspense>
        )}
        {tab === "sign-ins" && (
          <React.Suspense fallback={<SignInsSkeleton />}>
            <SignInsBody initial={initial} />
          </React.Suspense>
        )}
        {tab === "power" && (
          <React.Suspense fallback={<PowerSkeleton />}>
            <PowerBody initial={initial} />
          </React.Suspense>
        )}
      </div>
    </Page>
  );
}

function OverviewBody({ initial }: { initial: SystemInitial }) {
  const overview = initial.overview ? React.use(initial.overview) : undefined;
  const memory = initial.memory ? React.use(initial.memory) : undefined;
  return <OverviewTab initial={overview} memory={memory} />;
}

function UpdatesBody({ initial }: { initial: SystemInitial }) {
  return <UpdatesTab status={useUpdates(React.use(initial.updates))} />;
}

function ServicesBody({ initial, unit }: { initial: SystemInitial; unit: string | null }) {
  return <ServicesTab list={useServices("services", React.use(initial.services))} initialUnit={unit} />;
}

function SignInsBody({ initial }: { initial: SystemInitial }) {
  return <SignInsTab live={useLogins("sign-ins", initial.logins ? React.use(initial.logins) : undefined)} />;
}

function PowerBody({ initial }: { initial: SystemInitial }) {
  return <PowerTab initial={initial.power ? React.use(initial.power) : undefined} />;
}

type TabCount = { count?: number; attention: boolean };

/** Title and tabs, known before any host command answers; the summary and counts come with the data. */
function SystemHead({ tab, summary, counts = {} }: { tab: SystemTab; summary: React.ReactNode; counts?: { updates?: TabCount; services?: TabCount; signIns?: TabCount } }) {
  return (
    <>
      <PageHeader title="System" summary={summary} />
      <Tabs
        value={tab}
        hrefFor={(v) => (v === "overview" ? "/system" : `/system?tab=${v}`)}
        items={[
          { value: "overview", label: "Overview" },
          { value: "updates", label: "Updates", ...counts.updates },
          { value: "services", label: "Services", ...counts.services },
          { value: "sign-ins", label: "Sign-ins", ...counts.signIns },
          { value: "power", label: "Power" },
        ]}
        aria-label="System sections"
      />
    </>
  );
}

function SystemHeadLive({ tab, initial }: { tab: SystemTab; initial: SystemInitial }) {
  const fmt = useFormat();
  const updates = useUpdates(React.use(initial.updates));
  const services = useServices(tab, React.use(initial.services));
  const logins = useLogins(tab, initial.logins ? React.use(initial.logins) : undefined);

  // The server tells us when updates or services change; revalidate instead of waiting for the poll.
  useStream("/api/system/events", {
    updates: () => void updates.mutate(),
    services: () => void services.mutate(),
  });

  const u = updates.data;
  const failed = (services.data?.services ?? []).filter((x) => x.active === "failed");
  const failedImportant = failed.filter((x) => x.important);

  const parts: React.ReactNode[] = [];
  let lead: React.ReactNode = null;
  if (failedImportant.length === 1) lead = `${failedImportant[0]!.name} stopped working.`;
  else if (failedImportant.length > 1) lead = `${fmt.plural(failedImportant.length, "important service")} stopped working.`;
  else if (failed.length) parts.push(`${fmt.plural(failed.length, "service")} failed.`);
  if (u?.activeRun) parts.push("Updates are being installed.");
  else if (u && u.counts.total > 0) {
    const text = `${fmt.plural(u.counts.total, "update")} ${u.counts.total === 1 ? "is" : "are"} waiting${u.counts.security ? `, ${u.counts.security} of them security fixes` : ""}.`;
    if (!lead && updatesOverdue(u)) lead = text;
    else parts.push(text);
  }
  if (u?.reboot.required) {
    const text = "A restart is needed to finish updating.";
    if (!lead) lead = text;
    else parts.push(text);
  }
  // Who is signed in to the machine: someone from outside the home leads the sentence.
  const sessions = logins.data?.sessions ?? [];
  const awayPeople = [...new Set(sessions.filter((x) => x.from.zone === "away").map((x) => x.user))];
  const people = [...new Set(sessions.map((x) => x.user))];
  if (awayPeople.length) {
    const text = `${peopleList(awayPeople)} ${awayPeople.length === 1 ? "is" : "are"} signed in from outside your home network.`;
    if (!lead) lead = text;
    else parts.unshift(text);
  } else if (people.length) {
    parts.push(`${peopleList(people)} ${people.length === 1 ? "is" : "are"} signed in over SSH.`);
  }

  const summary =
    lead || parts.length ? (
      <>
        {lead && <b>{lead}</b>} {parts.join(" ")}
      </>
    ) : u && services.data && !updates.error && !services.error ? (
      // "Up to date" only when apt actually answered; a failed or missing check is not a clean bill.
      u.lastRefresh.ok === false ? (
        "Everything is running. Couldn't check for updates."
      ) : !u.lastRefresh.at ? (
        "Everything is running. Updates haven't been checked yet."
      ) : (
        "Everything is running and up to date."
      )
    ) : (
      unreadSummary(updates.error && !u ? updates.error : null, services.error && !services.data ? services.error : null)
    );

  return (
    <SystemHead
      tab={tab}
      summary={summary}
      counts={{
        updates: { count: u?.counts.total || undefined, attention: updatesOverdue(u) },
        services: { count: failed.length || undefined, attention: failedImportant.length > 0 },
        signIns: { count: people.length || undefined, attention: awayPeople.length > 0 },
      }}
    />
  );
}
