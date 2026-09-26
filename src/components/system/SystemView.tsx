"use client";
import * as React from "react";
import type { LiveLogins, PowerStatus, ServiceInfo, SystemOverview, UpdatesStatus } from "@/lib/system-types";
import { useApi, useStream } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { OverviewTab } from "./OverviewTab";
import { UpdatesTab } from "./UpdatesTab";
import { ServicesTab } from "./ServicesTab";
import { PowerTab } from "./PowerTab";
import { SignInsTab } from "./SignInsTab";
import { peopleList } from "./loginWords";
import s from "./system.module.css";

export type SystemTab = "overview" | "updates" | "services" | "sign-ins" | "power";

export interface SystemInitial {
  updates?: UpdatesStatus;
  services?: { services: ServiceInfo[] };
  overview?: SystemOverview;
  power?: PowerStatus;
  logins?: LiveLogins;
}

const DAY = 86_400_000;

/** Security fixes waiting more than 3 days, or anything waiting more than 30, is "needs you". */
export function updatesOverdue(u: UpdatesStatus | undefined): boolean {
  if (!u) return false;
  const t = Date.now();
  return (!!u.oldestSecurityAt && u.counts.security > 0 && t - u.oldestSecurityAt > 3 * DAY) || (!!u.oldestPendingAt && t - u.oldestPendingAt > 30 * DAY);
}

export function SystemView({ tab, unit, initial }: { tab: SystemTab; unit: string | null; initial: SystemInitial }) {
  const fmt = useFormat();
  // Shared with the tabs through SWR's cache (same keys), so the header and tabs agree.
  const updates = useApi<UpdatesStatus>("/api/system/updates", {
    refresh: 60_000,
    fallbackData: initial.updates,
  });
  const services = useApi<{ services: ServiceInfo[] }>("/api/system/services", {
    refresh: tab === "services" ? 10_000 : 30_000,
    fallbackData: initial.services,
  });

  const logins = useApi<LiveLogins>("/api/system/logins", {
    refresh: tab === "sign-ins" ? 5000 : 30_000,
    fallbackData: initial.logins,
  });

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
    ) : u && services.data ? (
      "Everything is running and up to date."
    ) : (
      "Updates, services, sign-ins and power for this server."
    );

  return (
    <Page>
      <PageHeader title="System" summary={summary} />
      <Tabs
        value={tab}
        hrefFor={(v) => (v === "overview" ? "/system" : `/system?tab=${v}`)}
        items={[
          { value: "overview", label: "Overview" },
          {
            value: "updates",
            label: "Updates",
            count: u?.counts.total || undefined,
            attention: updatesOverdue(u),
          },
          {
            value: "services",
            label: "Services",
            count: failed.length || undefined,
            attention: failedImportant.length > 0,
          },
          {
            value: "sign-ins",
            label: "Sign-ins",
            count: people.length || undefined,
            attention: awayPeople.length > 0,
          },
          { value: "power", label: "Power" },
        ]}
        aria-label="System sections"
      />
      <div className={s.tabBody}>
        {tab === "overview" && <OverviewTab initial={initial.overview} />}
        {tab === "updates" && <UpdatesTab status={updates} />}
        {tab === "services" && <ServicesTab list={services} initialUnit={unit} />}
        {tab === "sign-ins" && <SignInsTab live={logins} />}
        {tab === "power" && <PowerTab initial={initial.power} />}
      </div>
    </Page>
  );
}
