"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import type { ChannelView, MonitorView } from "@/lib/alerts-types";
import { alertsHref, type AlertsTab } from "@/lib/settings-links";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Section, Skeleton } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { SectionHeader } from "@/components/settings/SectionHeader";
import { CHANNELS_URL, MONITORS_URL } from "./shared";
import s from "./alerts.module.css";

// Each tab is its own page (a link), and only one shows: load just that one's code.
const loading = () => <Skeleton height={320} radius={12} />;
const MonitorsTab = dynamic(() => import("./MonitorsTab").then((m) => m.MonitorsTab), { loading });
const ChannelsTab = dynamic(() => import("./ChannelsTab").then((m) => m.ChannelsTab), { loading });
const SentTab = dynamic(() => import("./SentTab").then((m) => m.SentTab), { loading });
const HistoryTab = dynamic(() => import("./FindingsTabs").then((m) => m.HistoryTab), { loading });

/**
 * Settings → Alerts: what Gluon watches (monitors), where it tells you (shared channels and what was
 * sent), and the problems that cleared. What needs you now is on Status.
 */
export function AlertsSettings({ tab, monitorId, channelId }: { tab: AlertsTab; monitorId: string | null; channelId: string | null }) {
  const fmt = useFormat();
  const { data: monitors } = useApi<MonitorView[]>(MONITORS_URL, { refresh: 30_000 });
  const { data: channels } = useApi<ChannelView[]>(CHANNELS_URL, { refresh: 60_000 });

  const watched = monitors?.filter((m) => m.state !== "paused" && m.state !== "idle") ?? [];
  const down = watched.filter((m) => m.state === "down").length;
  const answering = watched.filter((m) => m.state === "up").length;
  const shared = channels?.filter((c) => c.owner === null) ?? [];
  const on = shared.filter((c) => c.enabled).length;

  const watching = !monitors
    ? null
    : watched.length === 0
      ? "Nothing is being watched yet."
      : down
        ? `${fmt.plural(down, "monitor")} down.`
        : answering === watched.length
          ? `All ${watched.length} monitors answering.`
          : `${answering} of ${watched.length} monitors answering.`;
  const telling = !channels ? null : on === 0 ? "Alerts aren't sent anywhere yet." : `Alerts go to ${fmt.plural(on, "shared channel")}.`;
  const summary =
    watching || telling ? (
      <>
        {watching && (down ? <b>{watching}</b> : watching)} {telling && (on === 0 ? <b>{telling}</b> : telling)}
      </>
    ) : (
      "What Gluon watches, where it tells you, and what went wrong before."
    );

  return (
    <>
      <SectionHeader summary={summary} />
      <Tabs
        value={tab}
        hrefFor={(v) => alertsHref(v)}
        items={[
          { value: "watching", label: "Watching", count: down || undefined, attention: down > 0 },
          { value: "notifications", label: "Notifications" },
          { value: "history", label: "Past problems" },
        ]}
        aria-label="Alerts sections"
      />
      <div className={s.tabBody}>
        {tab === "watching" && <MonitorsTab initialOpen={monitorId} />}
        {tab === "notifications" && (
          <>
            <ChannelsTab highlight={channelId} />
            <div className={s.sentSection}>
              <Section title="Sent" meta="Every alert, all-clear and daily summary, and whether it got through">
                <div className={s.stackBody}>
                  <SentTab />
                </div>
              </Section>
            </div>
          </>
        )}
        {tab === "history" && <HistoryTab />}
      </div>
    </>
  );
}
