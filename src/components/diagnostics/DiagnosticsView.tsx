"use client";
import * as React from "react";
import type { CheckupKind, CheckupRun, CheckupState, SecurityState } from "@/lib/diagnostics-types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { Time } from "@/components/ui/Time";
import { CheckupTab, CheckupSkeleton, type CheckupStart } from "./checkup/CheckupTab";
import { useCheckupRun, STATE_URL, SECURITY_URL } from "./checkup/useCheckupRun";
import { SecurityTab } from "./checkup/SecurityTab";
import { TrafficTab } from "./TrafficTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { RequestsTab } from "./RequestsTab";
import { ProcessesTab } from "./ProcessesTab";
import { LogsTab } from "./LogsTab";
import { ToolsTab } from "./ToolsTab";
import { AppsTab } from "./AppsTab";
import s from "./diagnostics.module.css";

export type DiagTab = "checkup" | "security" | "apps" | "traffic" | "connections" | "requests" | "processes" | "logs" | "tools";

const TAB_ITEMS: { value: DiagTab; label: string }[] = [
  { value: "checkup", label: "Checkup" },
  { value: "security", label: "Security" },
  { value: "apps", label: "Apps" },
  { value: "traffic", label: "Traffic" },
  { value: "connections", label: "Connections" },
  { value: "requests", label: "Requests" },
  { value: "processes", label: "Processes" },
  { value: "logs", label: "Logs" },
  { value: "tools", label: "Tools" },
];

/** The sentence under the title: what the last checkup of this kind found, or what's running. */
function CheckupSummary({ kind, latest }: { kind: CheckupKind; latest: CheckupRun | null | undefined }) {
  const live = useCheckupRun();
  const name = kind === "full" ? "full checkup" : "security checkup";
  if (live.streaming) return <>{(live.view?.meta.kind ?? live.pending?.kind) === kind ? `A ${name} is running.` : "A checkup is running."}</>;
  const sum = live.view?.summary?.status === "done" && live.view.meta.kind === kind ? live.view.summary : (latest?.summary ?? null);
  if (!sum) return <>No {name} has run yet.</>;
  const { fail, warn } = sum.counts;
  const found = !fail && !warn ? "everything checked out" : `${fail ? `${fail} ${fail === 1 ? "thing was" : "things were"} broken` : "nothing was broken"}${warn ? ` and ${warn} ${warn === 1 ? "thing" : "things"} needed a look` : ""}`;
  return (
    <>
      At the last {name}, <Time ts={sum.finishedAt} />, <strong>{found}</strong>.
    </>
  );
}

function FullSummary({ initial }: { initial: Promise<CheckupState | null> }) {
  const { data } = useApi<CheckupState>(STATE_URL, { fallbackData: React.use(initial) ?? undefined, refresh: 30_000 });
  return <CheckupSummary kind="full" latest={data?.latest} />;
}

function SecuritySummary({ initial }: { initial: SecurityState | null }) {
  const { data } = useApi<SecurityState>(SECURITY_URL, { fallbackData: initial ?? undefined, refresh: 30_000 });
  return <CheckupSummary kind="safety" latest={data?.latest} />;
}

function LiveSummary() {
  const fmt = useFormat();
  const live = useLive();
  const h = live.host.at(-1);
  if (live.status === "offline") return <>The live feed from this server dropped. Reconnecting…</>;
  // While reconnecting the last sample is old: it isn't "right now".
  if (!h || live.status !== "live") return <>Connecting to this server&apos;s live data…</>;
  return (
    <>
      Receiving <strong className="num">{fmt.rate(h.net.rx)}</strong> and sending <strong className="num">{fmt.rate(h.net.tx)}</strong> right now; the processor is{" "}
      <strong className="num">{fmt.percent(h.cpu)}</strong> busy.
    </>
  );
}

export function DiagnosticsView({ tab, logSource, logUnit, checkup, security, runId, start }: { tab: DiagTab; logSource: "kernel" | "journal" | "docker" | null; logUnit: string | null; checkup: Promise<CheckupState | null> | null; security: SecurityState | null; runId: string | null; start: CheckupStart | null }) {
  return (
    <Page>
      <PageHeader
        title="Diagnostics"
        summary={
          checkup ? (
            <React.Suspense fallback={<Skeleton width="min(380px, 80%)" height={12} />}>
              <FullSummary initial={checkup} />
            </React.Suspense>
          ) : tab === "security" ? (
            <SecuritySummary initial={security} />
          ) : (
            <LiveSummary />
          )
        }
      />
      <Tabs value={tab} hrefFor={(v) => (v === "checkup" ? "/diagnostics" : `/diagnostics?tab=${v}`)} items={TAB_ITEMS} aria-label="Diagnostics sections" />
      <div className={s.tabBody}>
        {checkup && (
          <React.Suspense fallback={<CheckupSkeleton />}>
            <CheckupTab initial={checkup} runId={runId} start={start} />
          </React.Suspense>
        )}
        {tab === "security" && <SecurityTab initial={security} autostart={start?.kind === "safety"} />}
        {tab === "apps" && <AppsTab />}
        {tab === "traffic" && <TrafficTab />}
        {tab === "connections" && <ConnectionsTab />}
        {tab === "requests" && <RequestsTab />}
        {tab === "processes" && <ProcessesTab />}
        {tab === "logs" && <LogsTab initialSource={logSource ?? "kernel"} initialUnit={logUnit} />}
        {tab === "tools" && <ToolsTab />}
      </div>
    </Page>
  );
}
