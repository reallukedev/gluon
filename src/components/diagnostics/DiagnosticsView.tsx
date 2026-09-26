"use client";
import type { CheckupState } from "@/lib/diagnostics-types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { Time } from "@/components/ui/Time";
import { CheckupTab, type CheckupStart } from "./checkup/CheckupTab";
import { useCheckupRun, STATE_URL } from "./checkup/useCheckupRun";
import { TrafficTab } from "./TrafficTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { RequestsTab } from "./RequestsTab";
import { ProcessesTab } from "./ProcessesTab";
import { LogsTab } from "./LogsTab";
import { ToolsTab } from "./ToolsTab";
import s from "./diagnostics.module.css";

export type DiagTab = "checkup" | "traffic" | "connections" | "requests" | "processes" | "logs" | "tools";

const TAB_ITEMS: { value: DiagTab; label: string }[] = [
  { value: "checkup", label: "Checkup" },
  { value: "traffic", label: "Traffic" },
  { value: "connections", label: "Connections" },
  { value: "requests", label: "Requests" },
  { value: "processes", label: "Processes" },
  { value: "logs", label: "Logs" },
  { value: "tools", label: "Tools" },
];

/** The sentence under the title on the Checkup tab: what the last checkup found, or what's running. */
function CheckupSummary({ initial }: { initial: CheckupState | null }) {
  const { data } = useApi<CheckupState>(STATE_URL, { fallbackData: initial ?? undefined, refresh: 30_000 });
  const live = useCheckupRun();
  if (live.streaming) return <>A checkup is running. Results appear below as each check finishes.</>;
  const sum = live.view?.summary?.status === "done" && live.view.meta.kind === "full" ? live.view.summary : (data?.latest?.summary ?? null);
  if (!sum) return <>No full checkup has run yet. One takes about a minute and changes nothing on the server.</>;
  const { fail, warn } = sum.counts;
  const found = !fail && !warn ? "everything checked out" : `${fail ? `${fail} ${fail === 1 ? "thing was" : "things were"} broken` : "nothing was broken"}${warn ? ` and ${warn} ${warn === 1 ? "thing" : "things"} needed a look` : ""}`;
  return (
    <>
      At the last full checkup, <Time ts={sum.finishedAt} />, <strong>{found}</strong>.
    </>
  );
}

function LiveSummary() {
  const fmt = useFormat();
  const live = useLive();
  const h = live.host.at(-1);
  if (live.status === "offline") return <>The live feed from this server dropped. Reconnecting…</>;
  if (!h) return <>Connecting to this server&apos;s live data…</>;
  return (
    <>
      Receiving <strong className="num">{fmt.rate(h.net.rx)}</strong> and sending <strong className="num">{fmt.rate(h.net.tx)}</strong> right now; the processor is{" "}
      <strong className="num">{fmt.percent(h.cpu)}</strong> busy.
    </>
  );
}

export function DiagnosticsView({ tab, logSource, logUnit, checkup, runId, start }: { tab: DiagTab; logSource: "kernel" | "journal" | "docker" | null; logUnit: string | null; checkup: CheckupState | null; runId: string | null; start: CheckupStart | null }) {
  return (
    <Page>
      <PageHeader title="Diagnostics" summary={tab === "checkup" ? <CheckupSummary initial={checkup} /> : <LiveSummary />} />
      <Tabs value={tab} hrefFor={(v) => (v === "checkup" ? "/diagnostics" : `/diagnostics?tab=${v}`)} items={TAB_ITEMS} aria-label="Diagnostics sections" />
      <div className={s.tabBody}>
        {tab === "checkup" && <CheckupTab initial={checkup} runId={runId} start={start} />}
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
