"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Clock, Community, HomeSimple, InfoCircle, Journal, Lock, NavArrowRight, Palette, PlugTypeA, Refresh, Server, SidebarExpand, WarningTriangle } from "iconoir-react";
import { useApi } from "@/lib/client/api";
import { GROUPS, type SettingsSection } from "./sections";
import s from "./settings.module.css";

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

/** The section in a /settings path, or null on /settings itself. */
export function sectionOf(pathname: string): string | null {
  return pathname.split("/")[2] || null;
}

/**
 * The Settings list and the frame around a section. It lives in settings/layout.tsx, so moving between
 * sections swaps only the content: the list stays mounted and keeps keyboard focus on the item clicked.
 */
export function SettingsFrame({ sections, children }: { sections: SettingsSection[]; children: React.ReactNode }) {
  const pathname = usePathname();
  const section = sectionOf(pathname);
  // Picking another section from the list settles only the content in (Shell keeps the whole page still
  // for clicks in the list); the first section shown arrives with the page.
  const [firstPath] = React.useState(pathname);
  const active = section ?? "appearance";
  const wide = sections.find((x) => x.id === active)?.wide;
  // Problem reports waiting for a reply (the sidebar's account button shows the same count).
  const { data: shell } = useApi<{ reports: number }>("/api/shell");
  const reports = shell?.reports ?? 0;

  return (
    <div className={s.frame}>
      <div className={s.layout} data-section={section ? "" : undefined} data-wide={wide ? "" : undefined}>
        <nav className={s.nav} aria-label="Settings">
          <h1 className={s.navTitle}>Settings</h1>
          {GROUPS.map((g) => {
            const items = sections.filter((x) => x.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className={s.navGroup}>
                <div className={`label ${s.navLabel}`}>{g.label}</div>
                {items.map((x) => {
                  const count = x.id === "people" ? reports : 0;
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
                      {count > 0 ? (
                        <span className={s.navCount} role="img" aria-label={countText} title={countText}>
                          <i aria-hidden />
                          <span aria-hidden className="num">
                            {count}
                          </span>
                        </span>
                      ) : null}
                      <NavArrowRight className={s.navChevron} aria-hidden />
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div key={pathname} className={s.content} data-settle={pathname !== firstPath ? "" : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}
