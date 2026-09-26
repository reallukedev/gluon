"use client";
import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Bell, Clock, Community, HomeSimple, InfoCircle, Lock, NavArrowRight, Palette, PlugTypeA, Refresh, Server, SidebarExpand } from "iconoir-react";
import type { SettingsSection } from "./sections";
import { SEARCH_ENGINES } from "@/lib/prefs";
import { orderedNav } from "@/lib/nav";
import { formatBytes, formatDate, formatTemp, formatTime } from "@/lib/format";
import { usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Skeleton } from "@/components/ui/Surface";
import { Appearance, HomePrefs, Navigation, Formats } from "./personal";
import s from "./settings.module.css";

const Security = dynamic(() => import("./Security").then((m) => m.Security), { loading: () => <Skeleton height={320} radius={12} /> });
const Server_ = dynamic(() => import("./Server").then((m) => m.Server), { loading: () => <Skeleton height={320} radius={12} /> });
const Household = dynamic(() => import("./Household").then((m) => m.Household), { loading: () => <Skeleton height={320} radius={12} /> });
const Updates = dynamic(() => import("./Updates").then((m) => m.Updates), { loading: () => <Skeleton height={200} radius={12} /> });
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
  household: Household,
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
  household: <Community />,
  updates: <Refresh />,
  about: <InfoCircle />,
};

/** One sentence of state under each section title, for the sections whose state is the viewer's own. */
function useSummary(id: string, fallback: string): React.ReactNode {
  const { prefs, viewer, timeZone } = usePrefs();
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
      const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, { memberStatus: true, memberFiles: true });
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

export function SettingsView({ sections, section }: { sections: SettingsSection[]; section: string | null }) {
  const active = section ?? "appearance";
  const current = sections.find((x) => x.id === active)!;
  const C = CONTENT[active];
  const summary = useSummary(active, current.summary);
  const groups = ["You", "Server"] as const;
  return (
    <Page>
      <div className={s.layout} data-section={section ? "" : undefined}>
        <nav className={s.nav} aria-label="Settings">
          <h1 className={s.navTitle}>Settings</h1>
          {groups.map((g) => {
            const items = sections.filter((x) => x.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className={s.navGroup}>
                <div className={`label ${s.navLabel}`}>{g === "You" ? "Just for you" : "Whole server"}</div>
                {items.map((x) => (
                  <Link key={x.id} href={`/settings/${x.id}`} className={s.navItem} aria-current={x.id === active && section ? "page" : undefined}
                    data-active={x.id === active ? "" : undefined}>
                    <span className={s.navIcon} aria-hidden>
                      {ICON[x.id]}
                    </span>
                    <span className={s.navText}>
                      {x.label}
                      <small>{x.hint}</small>
                    </span>
                    <NavArrowRight className={s.navChevron} aria-hidden />
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <div className={s.content}>
          <PageHeader title={current.label} summary={summary} back={{ href: "/settings", label: "Settings" }} />
          {C ? <C /> : null}
        </div>
      </div>
    </Page>
  );
}
