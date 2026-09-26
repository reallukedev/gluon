"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Finding } from "@/server/findings";
import type { ChannelView, MonitorView } from "@/lib/alerts-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Notice, Page, PageHeader } from "@/components/ui/Surface";
import { LinkButton } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Field";
import { OpenTab, HistoryTab, isActive } from "./FindingsTabs";
import { MonitorsTab } from "./MonitorsTab";
import { ChannelsTab } from "./ChannelsTab";
import { SentTab } from "./SentTab";
import { CHANNELS_URL, FINDINGS_URL, MONITORS_URL } from "./shared";
import s from "./alerts.module.css";

export type AlertsTab = "open" | "history" | "monitors" | "channels" | "sent";

export function AlertsView({ tab, initialFindings, monitorId, channelId }: { tab: AlertsTab; initialFindings: Finding[]; monitorId: string | null; channelId: string | null }) {
  const fmt = useFormat();
  const router = useRouter();
  const { data: findings = initialFindings } = useApi<Finding[]>(FINDINGS_URL, { refresh: 15_000, fallbackData: initialFindings });
  const { data: monitors } = useApi<MonitorView[]>(MONITORS_URL, { refresh: 30_000 });
  const { data: channels } = useApi<ChannelView[]>(CHANNELS_URL, { refresh: 60_000 });
  const unreachable = !!channels && !channels.some((c) => c.enabled);

  const active = findings.filter((f) => isActive(f));
  const faults = active.filter((f) => f.severity === "fault").length;
  const watched = monitors?.filter((m) => m.state !== "paused" && m.state !== "idle") ?? [];
  const down = watched.filter((m) => m.state === "down").length;
  const answering = watched.filter((m) => m.state === "up").length;

  const monitorSentence = !monitors
    ? ""
    : watched.length === 0
      ? ""
      : down
        ? `${fmt.plural(down, "monitor")} down.`
        : answering === watched.length
          ? `All ${watched.length} monitors answering.`
          : `${answering} of ${watched.length} monitors answering.`;

  const summary =
    active.length === 0 ? (
      <>
        <b>Nothing needs you.</b> {monitorSentence}
      </>
    ) : (
      <>
        <b>
          {fmt.plural(active.length, "thing")} need{active.length === 1 ? "s" : ""} you
          {faults ? `, ${faults} broken` : ""}.
        </b>{" "}
        {monitorSentence}
      </>
    );

  const problemsTab = tab === "open" || tab === "history";

  return (
    <Page>
      <PageHeader title="Alerts" summary={summary} />
      <Tabs
        value={problemsTab ? "open" : tab}
        hrefFor={(v) => (v === "open" ? "/alerts" : `/alerts?tab=${v}`)}
        items={[
          { value: "open", label: "Problems", count: active.length || undefined, attention: active.length > 0 },
          { value: "monitors", label: "Monitors", count: down || undefined, attention: down > 0 },
          { value: "channels", label: "Channels" },
          { value: "sent", label: "Sent" },
        ]}
        aria-label="Alert sections"
      />
      <div className={s.tabBody}>
        {problemsTab && (
          <div className={s.toolbar}>
            <Segmented
              aria-label="Which problems"
              value={tab === "history" ? "history" : "open"}
              onChange={(v) => router.replace(v === "history" ? "/alerts?tab=history" : "/alerts", { scroll: false })}
              options={[
                { value: "open", label: "Now" },
                { value: "history", label: "Cleared" },
              ]}
            />
          </div>
        )}
        {problemsTab && unreachable && (
          <Notice
            title="Gluon can't reach you yet"
            action={
              <LinkButton href="/alerts?tab=channels" size="sm">
                Set up a channel
              </LinkButton>
            }
          >
            Problems only show up on this page until you add somewhere to send them, like your phone or an inbox.
          </Notice>
        )}
        {tab === "open" && <OpenTab findings={findings} />}
        {tab === "history" && <HistoryTab />}
        {tab === "monitors" && <MonitorsTab initialOpen={monitorId} />}
        {tab === "channels" && <ChannelsTab highlight={channelId} />}
        {tab === "sent" && <SentTab />}
      </div>
    </Page>
  );
}
