"use client";
import * as React from "react";
import Link from "next/link";
import { useSWRConfig } from "swr";
import type { StatusPayload, StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import type { ChannelView } from "@/lib/alerts-types";
import { activityHref, alertsHref } from "@/lib/settings-links";
import { useApi } from "@/lib/client/api";
import { prefersReducedMotion } from "@/lib/client/motion";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Notice, Page, PageHeader, Panel } from "@/components/ui/Surface";
import { LinkButton } from "@/components/ui/Button";
import { QuietFindings } from "@/components/alerts/FindingsTabs";
import { CHANNELS_URL, FINDINGS_URL } from "@/components/alerts/shared";
import { StateLine } from "@/components/ui/StateLine";
import { NeedsYou } from "./NeedsYou";
import { MachineVitals, StorageBars } from "./Machine";
import { AppRoster } from "./AppRoster";
import { Console } from "./Console";
import { AppIcon } from "@/components/apps/AppIcon";
import { ReportProblem } from "./ReportProblem";
import { MyReports } from "@/components/people/MyReports";
import { Time } from "@/components/ui/Time";
import s from "./status.module.css";

/**
 * Status: is everything working? Members see a calm page of their apps. Admins see the verdict, what
 * needs them (with remedies), the machine and the apps.
 */
export function StatusView({ initial, allFindings }: { initial: StatusPayload; allFindings?: Finding[] }) {
  const { viewer } = usePrefs();
  if (viewer.role !== "admin") return <MemberView initial={initial} />;
  return <AdminStatus initial={initial} allFindings={allFindings} />;
}

function MemberView({ initial }: { initial: StatusPayload }) {
  const { data = initial } = useApi<StatusPayload>("/api/status", { refresh: 10_000, fallbackData: initial });
  return <MemberStatus data={data} />;
}

function AdminStatus({ initial, allFindings }: { initial: StatusPayload; allFindings?: Finding[] }) {
  const { data = initial, mutate, error } = useApi<StatusPayload>("/api/status", { refresh: 10_000, fallbackData: initial });
  const { mutate: globalMutate } = useSWRConfig();
  // Everything that shows findings refreshes together: the verdict, the lists and the sidebar count.
  const refresh = React.useCallback(() => {
    void mutate();
    void globalMutate(FINDINGS_URL);
    void globalMutate("/api/shell");
  }, [mutate, globalMutate]);

  return (
    <Page>
      <PageHeader
        title="Status"
        summary={
          <>
            <b>{data.verdict.headline}</b> {data.verdict.detail}
          </>
        }
      />
      <div className={s.body}>
        {error && (
          <Notice tone="fault" title="Couldn't refresh">
            {error.message} Showing the last reading; trying again.
          </Notice>
        )}
        <Overview data={data} allFindings={allFindings} refresh={refresh} />
      </div>
    </Page>
  );
}

function Overview({ data, allFindings, refresh }: { data: StatusPayload; allFindings: Finding[] | undefined; refresh: () => void }) {
  const fmt = useFormat();
  const { data: all } = useApi<Finding[]>(FINDINGS_URL, { refresh: 15_000, fallbackData: allFindings });
  const { data: channels } = useApi<ChannelView[]>(CHANNELS_URL, { refresh: 60_000 });
  const unreachable = !!channels && !channels.some((c) => c.enabled);
  const attentionMounts = new Set(data.findings.map((f) => f.subject ?? ""));
  const needsCount = data.findings.length;
  // The panel outlives its last item long enough for that item to settle and slide out.
  const needsShown = useLinger(needsCount > 0, NEEDS_EXIT_MS);
  const isNew = useArrivals(data.recent.map((e) => String(e.id)));
  const colsRef = React.useRef<HTMLDivElement>(null);
  useGlide(colsRef, needsShown);

  return (
    <>
      {unreachable && (
        <Notice
          title="No alerts set up, so problems only show up on this page"
          action={
            <LinkButton href={alertsHref("notifications")} size="sm">
              Set up alerts
            </LinkButton>
          }
        />
      )}
      {data.appsUnavailable && (
        <Notice
          tone="fault"
          title="Docker isn't answering"
          action={
            <LinkButton href="/system?tab=services" size="sm">
              Open services
            </LinkButton>
          }
        >
          Apps can&apos;t be listed until it answers. Checking again every few seconds.
        </Notice>
      )}
      <div className={s.cols} ref={colsRef}>
        <div className={s.main}>
          {needsShown && (
            <div className={s.needsWrap} data-closing={needsCount === 0 ? "" : undefined} data-motion-gentle="">
              <Panel title="Needs you" flush>
                <NeedsYou findings={data.findings} onChange={refresh} checkedAt={data.checkedAt} foot={null} empty={null} />
              </Panel>
            </div>
          )}
          {all && <QuietFindings findings={all} onChange={refresh} />}
          {data.recent.length > 0 && (
            <Panel title="Recently" meta={
                <span>
                  <Link href={alertsHref("history")}>Past problems</Link> · <Link href={activityHref()}>All activity</Link>
                </span>
              } className={s.recentPanel} flush>
              <ul className={s.recent} role="list">
                {foldRepeats(data.recent).slice(0, 8).map(({ entry: e, times }) => (
                  <li key={e.id} className={s.recentRow} data-outcome={e.outcome} data-arrived={isNew(String(e.id)) ? "" : undefined} data-motion-gentle="">
                    <Time ts={e.at} kind="dateTime" className={`${s.recentTime} num`} />
                    <span className={s.recentText}>
                      {e.kind === "user" && e.username ? <b>{e.username} </b> : null}
                      {e.kind === "user" ? e.summary.charAt(0).toLowerCase() + e.summary.slice(1) : e.summary}
                      {times > 1 && <span className={`${s.recentTimes} num`}> · {times} times</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
        <div className={s.side}>
          <Panel title="This machine" meta={data.uptime !== null ? <span>up {fmt.duration(data.uptime, 2)}</span> : undefined} className={s.machinePanel}>
            <MachineVitals />
          </Panel>
          <Panel title="Storage" meta={<Link href="/storage">Details</Link>} className={s.storagePanel}>
            <StorageBars filesystems={data.filesystems} attentionMounts={attentionMounts} />
          </Panel>
        </div>
        <Panel title="Apps" meta={<AppsMeta apps={data.apps} />} className={s.appsPanel} flush>
          <Console apps={data.apps} findings={data.findings} />
          <AppRoster apps={data.apps} findings={data.findings} />
        </Panel>
      </div>
    </>
  );
}

/** "11 running · 2 stopped", counting apps (not their containers), old copies left out. */
type Recent = StatusPayload["recent"][number];

/** Back-to-back repeats of the same thing ("admin signed in" eight times) read as one line with a count. */
function foldRepeats(entries: Recent[]) {
  const out: { entry: Recent; times: number }[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last.entry.kind === e.kind && last.entry.username === e.username && last.entry.summary === e.summary && last.entry.outcome === e.outcome) last.times++;
    else out.push({ entry: e, times: 1 });
  }
  return out;
}

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
        Checked at <Time ts={data.checkedAt} kind="time" />
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

const NEEDS_EXIT_MS = 600;

/** True while `on`, and for `ms` after it turns off, so a closing panel can play out. */
function useLinger(on: boolean, ms: number) {
  const [shown, setShown] = React.useState(on);
  React.useEffect(() => {
    if (on) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on || shown;
}

/** When the Needs you panel comes or goes, the panels it moved glide to their new place. */
function useGlide(root: React.RefObject<HTMLDivElement | null>, key: boolean) {
  // Positions are re-read after every commit so a glide starts from where things really were,
  // not where they sat when the page loaded; only a change of `key` moves anything.
  const tops = React.useRef(new Map<Element, number>());
  const lastKey = React.useRef(key);
  React.useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(":scope > div > *, :scope > section")];
    const before = tops.current;
    const next = new Map<Element, number>();
    const moved: [HTMLElement, number][] = [];
    for (const item of items) {
      const top = item.getBoundingClientRect().top + window.scrollY;
      next.set(item, top);
      const old = before.get(item);
      if (old !== undefined && Math.abs(old - top) > 1) moved.push([item, old - top]);
    }
    tops.current = next;
    const changed = lastKey.current !== key;
    lastKey.current = key;
    if (!changed || !moved.length || prefersReducedMotion()) return;
    for (const [item, dy] of moved) item.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 250, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  });
}

/** Rows that weren't on the first render are arrivals; only those animate in. */
function useArrivals(ids: string[]) {
  const [first] = React.useState(() => new Set(ids));
  return React.useCallback((id: string) => !first.has(id), [first]);
}
