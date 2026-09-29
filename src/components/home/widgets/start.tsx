"use client";
// Things that open a Home page or sit on it as one line: the greeting, the search bar, a folder, a link.
import * as React from "react";
import { Folder } from "iconoir-react";
import { registerWidget } from "../widgetStore";
import type { SettingsProps, WidgetProps } from "../types";
import { useApi } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Field, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import type { Places } from "@/lib/files-types";
import { Greeting } from "../Greeting";
import { StartSearch } from "../StartSearch";
import { Preview } from "../previews";
import { SetUp } from "./kit";
import st from "./start.module.css";

// ================================================================ greeting

function useToday() {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function GreetingWidget() {
  const fmt = useFormat();
  const now = useToday();
  return (
    <div className={st.greeting}>
      <Greeting />
      <p className={st.today} suppressHydrationWarning>
        {now ? fmt.date(now, { weekday: true, year: false }) : " "}
      </p>
    </div>
  );
}

registerWidget({
  type: "greeting",
  name: "Greeting",
  description: "Good morning, by name, with today's date. Turn the name off in Settings → Appearance.",
  category: "For you",
  sizes: ["h", "b"],
  defaultSize: "h",
  defaultConfig: {},
  bare: true,
  keywords: "hello name date welcome",
  Component: GreetingWidget,
  preview: <Preview of="greeting" />,
});

// ================================================================ search

function SearchWidget() {
  return (
    <div className={st.searchWrap}>
      <StartSearch />
    </div>
  );
}

registerWidget({
  type: "search",
  name: "Search bar",
  description: "Type to jump to an app, or press Enter to search the web with your search engine.",
  category: "For you",
  sizes: ["h", "b"],
  defaultSize: "h",
  defaultConfig: {},
  bare: true,
  keywords: "find web google duckduckgo",
  Component: SearchWidget,
  preview: <Preview of="search" />,
});

// ================================================================ folder

export interface FolderConfig {
  path?: string;
  label?: string;
}

/** Is `p` the same as or inside `root`? */
const within = (p: string, root: string) => root === "/" || p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export const filesHref = (path: string) => `/files?path=${encodeURIComponent(path)}`;

function FolderWidget({ item, size, openSettings }: WidgetProps<FolderConfig>) {
  const { data, error } = useApi<Places>("/api/files/places", { refresh: 300_000, revalidateOnFocus: false });
  const fmt = useFormat();
  const path = item.config.path;
  if (!path) {
    return (
      <div className={st.card} data-size={size}>
        <span className={st.cardText}>
          <b>Which folder?</b>
          <SetUp openSettings={openSettings}>Choose</SetUp>
        </span>
      </div>
    );
  }
  if (!data && !error) {
    return (
      <div className={st.card} data-size={size} aria-busy="true">
        <Skeleton width={28} height={28} radius={7} />
        <span className={st.cardText}>
          <Skeleton width="60%" height={13} />
          <Skeleton width="40%" height={10} />
        </span>
      </div>
    );
  }
  const all = [...(data?.places ?? []), ...(data?.pins ?? [])];
  const exact = all.find((p) => p.path === path);
  // Members only see folders shared with them (and folders inside those); Files checks again when it opens.
  const visible = !data || data.admin || all.some((p) => p.kind === "grant" && within(path, p.path));
  const label = item.config.label || exact?.label || path.split("/").filter(Boolean).pop() || "Computer";
  if (!visible) {
    return (
      <div className={st.card} data-size={size} data-off="">
        <span className={st.icon} aria-hidden>
          <Folder />
        </span>
        <span className={st.cardText}>
          <b title={label}>{label}</b>
          <span>Not shared with you any more</span>
        </span>
      </div>
    );
  }
  const fs = exact?.fs;
  const detail = exact?.missing ? "Missing" : fs ? `${fmt.bytes(fs.avail)} free` : (exact?.detail ?? null);
  return (
    <a className={st.card} data-size={size} href={filesHref(path)} data-off={exact?.missing ? "" : undefined} title={path}>
      <span className={st.icon} aria-hidden>
        <Folder />
      </span>
      <span className={st.cardText}>
        <b>{label}</b>
        <span className={detail ? undefined : "mono"}>{detail ?? path}</span>
      </span>
    </a>
  );
}

function FolderSettings({ config, onChange }: SettingsProps<FolderConfig>) {
  const { data } = useApi<Places>("/api/files/places");
  if (!data) return <Skeleton height={80} />;
  const options = [...data.pins, ...data.places.filter((p) => !data.pins.some((x) => x.path === p.path))];
  return (
    <div className={st.form}>
      <Field label="Folder" description="Your pinned folders in Files, and the folders you can open.">
        <div className={st.pick} role="radiogroup" aria-label="Folder">
          {options.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={config.path === p.path}
              className={st.pickItem}
              onClick={() => onChange({ ...config, path: p.path, label: config.label })}
            >
              <Folder aria-hidden />
              <span>
                {p.label}
                <small className="mono">{p.path}</small>
              </span>
            </button>
          ))}
          {!options.length && <p className={st.none}>No folders to choose from yet.</p>}
        </div>
      </Field>
      <Field label="Name" optional>
        <Input value={config.label ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, label: e.target.value || undefined })} placeholder="As Files names it" />
      </Field>
    </div>
  );
}

registerWidget<FolderConfig>({
  type: "folder",
  name: "Folder",
  description: "A shortcut that opens a folder in Files.",
  category: "For you",
  sizes: ["c", "s"],
  defaultSize: "c",
  defaultConfig: {},
  bare: true,
  multiple: true,
  hidden: true,
  label: (c) => c.label ?? c.path ?? null,
  Component: FolderWidget,
  Settings: FolderSettings,
  preview: <Preview of="folder" />,
});

// ================================================================ link

export interface LinkConfig {
  url?: string;
  title?: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};

function LinkWidget({ item, size, openSettings }: WidgetProps<LinkConfig>) {
  const { prefs } = usePrefs();
  const [failed, setFailed] = React.useState(false);
  const url = item.config.url;
  if (!url) {
    return (
      <div className={st.card} data-size={size}>
        <span className={st.cardText}>
          <b>Which site?</b>
          <SetUp openSettings={openSettings}>Add a link</SetUp>
        </span>
      </div>
    );
  }
  const title = item.config.title || hostOf(url);
  return (
    <a className={st.card} data-size={size} href={url} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer" title={url}>
      <span className={st.icon} aria-hidden>
        {failed ? (
          (title[0] ?? "?").toUpperCase()
        ) : (
          // Fetched by Gluon's server, so the sites you pin aren't sent to a third-party icon service.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/favicon?url=${encodeURIComponent(url)}`} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
      </span>
      <span className={st.cardText}>
        <b>{title}</b>
        <span>{hostOf(url)}</span>
      </span>
    </a>
  );
}

function LinkSettings({ config, onChange }: SettingsProps<LinkConfig>) {
  const [url, setUrl] = React.useState(config.url ?? "");
  return (
    <div className={st.form}>
      <Field label="Address">
        <Input
          value={url}
          onChange={(e) => {
            const v = e.target.value.trim();
            setUrl(e.target.value);
            onChange({ ...config, url: v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : undefined });
          }}
          placeholder="example.com"
          mono
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
        />
      </Field>
      <Field label="Name" optional>
        <Input value={config.title ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, title: e.target.value || undefined })} placeholder={config.url ? hostOf(config.url) : "Bank"} />
      </Field>
    </div>
  );
}

registerWidget<LinkConfig>({
  type: "link",
  name: "Link",
  description: "One site you open every day, as a card. Pin as many as you like.",
  category: "For you",
  sizes: ["c", "s"],
  defaultSize: "c",
  defaultConfig: {},
  bare: true,
  multiple: true,
  setupOnPin: true,
  keywords: "bookmark website shortcut url",
  label: (c) => c.title || (c.url ? hostOf(c.url) : null),
  Component: LinkWidget,
  Settings: LinkSettings,
  preview: <Preview of="link" />,
});

export {};
