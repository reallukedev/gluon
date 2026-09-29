"use client";
import * as React from "react";
import Link from "next/link";
import type { StatusPayload, StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import { useApi } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel } from "@/components/ui/Surface";
import { instanceHints, sourceName } from "@/lib/app-names";
import { StateLine } from "@/components/ui/StateLine";
import type { SpectrumGroup } from "@/components/spectrum/Spectrum";
import { NeedsYou } from "./NeedsYou";
import { MachineVitals, StorageBars } from "./Machine";
import { AppRoster } from "./AppRoster";
import { Console } from "./Console";
import { AppIcon } from "@/components/apps/AppIcon";
import { ReportProblem } from "./ReportProblem";
import { MyReports } from "@/components/people/MyReports";
import { Time } from "@/components/ui/Time";
import s from "./status.module.css";

export function spectrumGroups(apps: StatusApp[], findings: Finding[], filesystems: StatusPayload["filesystems"], fmtBytes: (n: number) => string): SpectrumGroup[] {
  const attentionSubjects = new Set(findings.filter((f) => f.severity === "attention").map((f) => f.subject));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const hints = instanceHints(apps.filter((a) => !(a.copyOf && byId.has(a.copyOf.id))));
  // An old copy sits inside the app it copies, a step apart, instead of taking a label of its own.
  const copies = new Map<string, StatusApp[]>();
  for (const a of apps) if (a.copyOf && byId.has(a.copyOf.id) && a.containers.length) copies.set(a.copyOf.id, [...(copies.get(a.copyOf.id) ?? []), a]);
  const lines = (a: StatusApp, copy: boolean) =>
    a.containers.map((c, i) => ({
      id: c.name,
      label: c.service ?? c.name,
      container: c.name,
      href: copy ? `/apps/${encodeURIComponent(a.id)}` : undefined,
      note: copy ? `Old copy from ${sourceName(a.source)}` : undefined,
      gapBefore: copy && i === 0,
      state: attentionSubjects.has(a.id) && c.line === "running" ? ("attention" as const) : c.line,
    }));
  const groups: SpectrumGroup[] = apps
    .filter((a) => a.containers.length && !(a.copyOf && byId.has(a.copyOf.id)))
    .map((a) => ({
      id: `app:${a.id}`,
      label: hints.get(a.id) ? `${a.name} · ${hints.get(a.id)}` : a.name,
      href: `/apps/${encodeURIComponent(a.id)}`,
      lines: [...lines(a, false), ...(copies.get(a.id) ?? []).flatMap((c) => lines(c, true))],
    }));
  if (filesystems.length) {
    groups.push({
      id: "storage",
      label: "Storage",
      href: "/storage",
      lines: filesystems
        .filter((f) => f.size > 512 * 1024 * 1024)
        .map((f) => {
          const finding = findings.find((x) => x.subject === f.mount);
          return {
            id: `fs:${f.mount}`,
            label: f.mount,
            state: finding ? (finding.severity === "fault" ? ("unhealthy" as const) : ("attention" as const)) : ("running" as const),
            detail: `${Math.round(f.pct)}% of ${fmtBytes(f.size)} used`,
            href: `/storage?usage=${encodeURIComponent(f.mount)}`,
          };
        }),
    });
  }
  return groups;
}

export function StatusView({ initial }: { initial: StatusPayload }) {
  const { viewer } = usePrefs();
  const fmt = useFormat();
  const { data = initial, mutate } = useApi<StatusPayload>("/api/status", { refresh: 10_000, fallbackData: initial });
  const refresh = React.useCallback(() => void mutate(), [mutate]);

  if (viewer.role !== "admin") return <MemberStatus data={data} />;

  const attentionMounts = new Set(data.findings.map((f) => f.subject ?? ""));

  return (
    <Page>
      <PageHeader
        title="Status"
        summary={
          <>
            <b>{data.verdict.headline}</b> {data.verdict.detail}
          </>
        }
        actions={<HeaderInstrument checkedAt={data.checkedAt} />}
      />

      <div className={s.cols}>
        <Panel
          title="Needs you"
          meta={data.findings.length ? <span className="num">{data.findings.length} open</span> : undefined}
          flush
        >
          <NeedsYou findings={data.findings} onChange={refresh} checkedAt={data.checkedAt} />
        </Panel>
        <div className={s.side}>
          <Panel title="This machine" meta={data.uptime !== null ? <span>up {fmt.duration(data.uptime, 2)}</span> : undefined}>
            <MachineVitals />
          </Panel>
          <Panel title="Storage" meta={<Link href="/storage">Details</Link>}>
            <StorageBars filesystems={data.filesystems} attentionMounts={attentionMounts} />
          </Panel>
        </div>
      </div>

      <Panel title="Apps" meta={<AppsMeta apps={data.apps} />} className={s.appsPanel} flush>
        <Console apps={data.apps} findings={data.findings} />
        <AppRoster apps={data.apps} findings={data.findings} />
      </Panel>

      {data.recent.length > 0 && (
        <Panel title="Recently" meta={<Link href="/activity">All activity</Link>} className={s.recentPanel} flush>
          <ul className={s.recent} role="list">
            {data.recent.map((e) => (
              <li key={e.id} className={s.recentRow} data-outcome={e.outcome}>
                <Time ts={e.at} kind="dateTime" className={`${s.recentTime} num`} />
                <span className={s.recentText}>
                  {e.kind === "user" && e.username ? <b>{e.username} </b> : null}
                  {e.kind === "user" ? e.summary.charAt(0).toLowerCase() + e.summary.slice(1) : e.summary}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Page>
  );
}

/** "11 running · 2 stopped", counting apps (not their containers), old copies left out. */
function AppsMeta({ apps }: { apps: StatusApp[] }) {
  const ids = new Set(apps.map((a) => a.id));
  const current = apps.filter((a) => !(a.copyOf && ids.has(a.copyOf.id)));
  const running = current.filter((a) => a.line !== "stopped").length;
  const stopped = current.length - running;
  return (
    <span className="num">
      {running} running{stopped > 0 && ` · ${stopped} stopped`} · <Link href="/apps">Manage</Link>
    </span>
  );
}

function MemberStatus({ data }: { data: StatusPayload }) {
  return (
    <Page narrow>
      <PageHeader title={data.verdict.headline} summary={data.verdict.detail} actions={<ReportProblem apps={data.apps} />} />
      {data.announcements.length > 0 && (
        <div className={s.announcements}>
          {data.announcements.map((a) => (
            <p key={a.id}>{a.message}</p>
          ))}
        </div>
      )}
      {data.apps.length > 0 && (
        <Panel flush>
          <ul className={s.memberApps} role="list">
            {data.apps.map((a) => (
              <li key={a.id} className={s.memberApp}>
                <AppIcon src={a.icon} name={a.name} size={36} />
                <div className={s.memberAppText}>
                  <span className={s.memberAppName}>{a.name}</span>
                  <StateLine state={a.line} label={a.line === "running" ? "Working" : a.line === "starting" ? "Starting up" : "Not working"} />
                </div>
                {a.line === "running" && (a.urls.home || a.urls.away) && <OpenLink urls={a.urls} />}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <MyReports />
      <p className={s.memberFoot}>
        Checked at <Time ts={data.checkedAt} kind="time" />. This page keeps itself up to date.
      </p>
    </Page>
  );
}

function OpenLink({ urls }: { urls: StatusApp["urls"] }) {
  const { viewer, prefs } = usePrefs();
  const href = viewer.zone === "home" ? (urls.home ?? urls.away) : (urls.away ?? urls.home);
  if (!href) return null;
  return (
    <a className={s.open} href={href} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer">
      Open
    </a>
  );
}

/** The tracked date line across from the verdict (search lives in the sidebar). */
function HeaderInstrument({ checkedAt }: { checkedAt: number }) {
  const fmt = useFormat();
  return (
    <span className={`${s.dateLine} num`} suppressHydrationWarning>
      {fmt.date(checkedAt, { weekday: true })} · {fmt.time(checkedAt)}
    </span>
  );
}
