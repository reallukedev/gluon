"use client";
import { HomeSimple, Globe, ArrowUpRight } from "iconoir-react";
import type { AppSummary } from "@/server/docker/apps";
import { linkTarget } from "@/lib/client/open-link";
import { usePrefs } from "@/components/PrefsProvider";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import s from "./addresses.module.css";

interface Address {
  key: string;
  url: string;
  text: string;
  where: "home" | "public";
  title: string;
  partly: boolean;
}

/**
 * Where an app opens, as one hairline tag (never a pill) that reads as a link: the address that works
 * from where the viewer is (the home port at home, a public address away), and the rest one click
 * deeper behind "+N", so a row stays one line however many addresses an app has.
 */
export function Addresses({ app, empty = "No web page" }: { app: Pick<AppSummary, "urls" | "webPort" | "routes">; empty?: string }) {
  const { viewer } = usePrefs();
  const all: Address[] = [];
  if (app.urls.home) {
    all.push({ key: "home", url: app.urls.home, text: app.webPort ? `:${app.webPort}` : app.urls.home.replace(/^https?:\/\//, ""), where: "home", title: `Open at home: ${app.urls.home}`, partly: false });
  }
  for (const r of app.routes.filter((r) => r.enabled)) {
    all.push({
      key: r.id,
      url: r.url,
      text: r.url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      where: "public",
      title: `Open from anywhere: ${r.url}${r.onlyPaths?.length ? ` (only ${r.onlyPaths.join(", ")})` : ""}`,
      partly: !!r.onlyPaths?.length,
    });
  }
  if (!all.length) return <span className={s.none}>{empty}</span>;

  const away = viewer.zone === "away";
  const first = (away && all.find((a) => a.where === "public")) || all[0]!;
  const rest = all.filter((a) => a !== first);
  const items: MenuEntry[] = all.map((a) => ({
    label: a.where === "home" ? a.url.replace(/^https?:\/\//, "") : a.text,
    description: a.where === "home" ? "At home" : a.partly ? "From anywhere, some paths" : "From anywhere",
    icon: a.where === "home" ? <HomeSimple /> : <Globe />,
    onSelect: () => window.open(a.url, linkTarget(a.url, true) ?? "_self", "noopener"),
  }));

  return (
    <span className={s.list}>
      <span className={s.lead} aria-hidden>
        Open at
      </span>
      <a href={first.url} target={linkTarget(first.url, true)} rel="noopener noreferrer" className={s.tag} data-public={first.where === "public" ? "" : undefined} title={first.title}>
        {first.where === "home" ? <HomeSimple aria-hidden /> : <Globe aria-hidden />}
        <span className="sr-only">{first.where === "home" ? "Open at home: " : "Open from anywhere: "}</span>
        <span className={s.text}>{first.text}</span>
        {first.partly ? <span className={s.partly}>some paths</span> : null}
        <ArrowUpRight aria-hidden className={s.arrow} />
      </a>
      {rest.length > 0 && (
        <Menu
          align="start"
          items={items}
          trigger={
            <button type="button" className={s.more} aria-label={`All ${all.length} addresses`} title={`All ${all.length} addresses`}>
              +{rest.length}
            </button>
          }
        />
      )}
    </span>
  );
}
