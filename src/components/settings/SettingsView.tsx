"use client";
import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Bell, Clock, Community, HomeSimple, InfoCircle, Journal, Lock, NavArrowRight, Palette, PlugTypeA, Refresh, Server, SidebarExpand, WarningTriangle } from "iconoir-react";
import { GROUPS, type SettingsSection } from "./sections";
import type { ActivityPage, PersonView } from "@/lib/people-types";
import type { AlertsTab, PeopleTab } from "@/lib/settings-links";
import { useApi } from "@/lib/client/api";
import { SectionHeaderProvider } from "./SectionHeader";
import { SEARCH_ENGINES } from "@/lib/prefs";
import { orderedNav } from "@/lib/nav";
import { useNavAccess } from "@/components/shell/Shell";
import { formatBytes, formatDate, formatTemp, formatTime } from "@/lib/format";
import { usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";
import { Appearance, HomePrefs, Navigation, Formats } from "./personal";
import s from "./settings.module.css";

const Security = dynamic(() => import("./Security").then((m) => m.Security), { loading: () => <Skeleton height={320} radius={12} /> });
const Server_ = dynamic(() => import("./Server").then((m) => m.Server), { loading: () => <Skeleton height={320} radius={12} /> });
const AlertsSettings = dynamic(() => import("@/components/alerts/AlertsSettings").then((m) => m.AlertsSettings), { loading: () => <Skeleton height={320} radius={12} /> });
const ActivityView = dynamic(() => import("@/components/activity/ActivityView").then((m) => m.ActivityView), { loading: () => <Skeleton height={320} radius={12} /> });
const PeopleSettings = dynamic(() => import("@/components/people/PeopleView").then((m) => m.PeopleSettings), { loading: () => <Skeleton height={320} radius={12} /> });

/** What the Keep watch sections start with (read on the server for the section being opened). */
export type SectionData =
  | { kind: "alerts"; tab: AlertsTab; monitorId: string | null; channelId: string | null }
  | {
      kind: "activity";
      initial: ActivityPage;
      people: { id: string; name: string; username: string }[];
      initialTarget: string;
      initialUser: string;
      pageSize: number;
    }
  | { kind: "people"; tab: PeopleTab; initialPeople: PersonView[]; person: PersonView | null; reportId: string | null }
  | null;const Updates = dynamic(() => import("./Updates").then((m) => m.Updates), { loading: () => <Skeleton height={200} radius={12} /> });
const About = dynamic(() => import("./About").then((m) => m.About), { loading: () => <Skeleton height={200} radius={12} /> });
const Notifications = dynamic(() => import("./Notifications").then((m) => m.Notifications), { loading: () => <Skeleton height={320} radius={12} /> });
const Integrations = dynamic(() => import("./Integrations").then((m) => m.Integrations), { loading: () => <Skeleton height={320} radius={12} /> });

const CONTENT: Record<string, React.ComponentType> = {
  appearance: Appearance,
  home: HomePrefs,
  navigation: Navigation,
  formats: Formats,
  security: Security,
  server: Server_,
  updates: Updates,
  about: About,
  notifications: Notifications,
  integrations: Integrations,
};

const ICON: Record<string, React.ReactNode> = {
  appearance: <Palette />,
  home: <HomeSimple />,
  navigation: <SidebarExpand />,
  formats: <Clock />,
  notifications: <Bell />,
  security: <Lock />,
  server: <Server />,
  integrations: <PlugTypeA />,
  alerts: <WarningTriangle />,
  activity: <Journal />,
  people: <Community />,
  updates: <Refresh />,
  about: <InfoCircle />,
};

/** One sentence of state under each section title, for the sections whose state is the viewer's own. */
function useSummary(id: string, fallback: string): React.ReactNode {
  const { prefs, viewer, timeZone } = usePrefs();
  const access = useNavAccess();
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => setNow(Date.now()), []);
  switch (id) {
    case "appearance": {
      const theme = prefs.theme === "system" ? "Matching your device" : prefs.theme === "dark" ? "Dark" : "Light";
      const bits = [
        `${prefs.attention === "sodium" ? "sodium" : prefs.attention} for things that need you`,
        prefs.textSize !== "default" ? `${prefs.textSize === "large" ? "larger" : "smaller"} text` : null,
        prefs.density === "compact" ? "compact rows" : null,
        prefs.contrast === "more" ? "more contrast" : null,
        prefs.motion === "reduce" ? "less motion" : null,
      ].filter(Boolean);
      return `${theme}, with ${bits.join(", ")}.`;
    }
    case "home": {
      const engine = prefs.searchEngine === "custom" ? "your own search address" : SEARCH_ENGINES[prefs.searchEngine].name;
      const start = { home: "Home", status: "Status", apps: "Apps", files: "Files" }[prefs.startPage];
      return `Gluon opens on ${start}. The search box uses ${engine}.`;
    }
    case "navigation": {
      const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, access);
      return `${nav.visible.length} of ${nav.all.length} pages in the sidebar${nav.hidden.length ? `, ${nav.hidden.length} tucked away` : ""}. Single-key shortcuts are ${prefs.shortcuts ? "on" : "off"}.`;
    }
    case "formats": {
      if (now === null) return fallback;
      const eff = { ...prefs, timezone: timeZone ?? "UTC" };
      return `${formatTime(now, eff)} on ${formatDate(now, eff, { year: true })}. Sizes like ${formatBytes(2e12, prefs.bytes)}, temperatures in ${formatTemp(20, prefs.temperature).replace(/[\d.\s]/g, "")}.`;
    }
    default:
      return fallback;
  }
}

export function SettingsView({ sections, section, data = null }: { sections: SettingsSection[]; section: string | null; data?: SectionData }) {
  const active = section ?? "appearance";
  const current = sections.find((x) => x.id === active)!;
  const C = CONTENT[active];
  const summary = useSummary(active, current.summary);
  // Household problem reports waiting for a reply (the sidebar's account button shows the same count).
  const { data: shell } = useApi<{ reports: number }>("/api/shell");
  const reports = shell?.reports ?? 0;
  const back = { href: "/settings", label: "Settings" };

  const own =
    data?.kind === "alerts" ? (
      <AlertsSettings key={data.tab} tab={data.tab} monitorId={data.monitorId} channelId={data.channelId} />
    ) : data?.kind === "activity" ? (
      <ActivityView key={`${data.initialTarget}|${data.initialUser}`} initial={data.initial} people={data.people} initialTarget={data.initialTarget} initialUser={data.initialUser} pageSize={data.pageSize} />
    ) : data?.kind === "people" ? (
      <PeopleSettings key={data.person?.id ?? data.tab} tab={data.tab} initialPeople={data.initialPeople} person={data.person} reportId={data.reportId} />
    ) : null;

  return (
    <Page>
      <div className={s.layout} data-section={section ? "" : undefined} data-wide={current.wide ? "" : undefined}>
        <nav className={s.nav} aria-label="Settings">
          <h1 className={s.navTitle}>Settings</h1>
          {GROUPS.map((g) => {
            const items = sections.filter((x) => x.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className={s.navGroup}>
                <div className={`label ${s.navLabel}`}>{g.label}</div>
                {items.map((x) => {
                  const count = x.id === "people" && reports > 0 ? reports : 0;
                  const countText = count ? `${count} problem report${count === 1 ? "" : "s"} waiting` : "";
                  return (
                    <Link
                      key={x.id}
                      href={`/settings/${x.id}`}
                      className={s.navItem}
                      aria-current={x.id === active && section ? "page" : undefined}
                      data-active={x.id === active ? "" : undefined}
                    >
                      <span className={s.navIcon} aria-hidden>
                        {ICON[x.id]}
                      </span>
                      <span className={s.navText}>
                        {x.label}
                        <small>{x.hint}</small>
                      </span>
                      {count > 0 && (
                        <span className={s.navCount} role="img" aria-label={countText} title={countText}>
                          <i aria-hidden />
                          <span aria-hidden className="num">
                            {count}
                          </span>
                        </span>
                      )}
                      <NavArrowRight className={s.navChevron} aria-hidden />
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className={s.content}>
          {current.ownHeader ? (
            <SectionHeaderProvider value={{ title: current.label, back }}>{own}</SectionHeaderProvider>
          ) : (
            <>
              <PageHeader title={current.label} summary={summary} back={back} />
              {C ? <C /> : null}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
