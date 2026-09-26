"use client";
import { instanceHints, shortName } from "@/lib/app-names";
import * as React from "react";
import Link from "next/link";
import { Plus, Trash } from "iconoir-react";
import type { WidgetProps, SettingsProps } from "../types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { StateLine } from "@/components/ui/StateLine";
import { AppIcon } from "@/components/apps/AppIcon";
import { TimeChart } from "@/components/charts/TimeChart";
import { UsageBar, Skeleton } from "@/components/ui/Surface";
import { Field, Input, Checkbox } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { Spectrum } from "@/components/spectrum/Spectrum";
import { spectrumGroups } from "@/components/status/StatusView";
import type { StatusPayload } from "@/server/status";
import s from "./widgets.module.css";

// ---------------------------------------------------------------- helpers

export interface HomeApp {
  id: string;
  name: string;
  icon: string | null;
  line: StatusPayload["apps"][number]["line"];
  summary: string;
  urls: { home: string | null; away: string | null };
  description?: string | null;
}

/** The right address for where you are: LAN address at home, public address when away. */
export function useSmartUrl() {
  const { viewer } = usePrefs();
  return (urls: HomeApp["urls"]) => (viewer.zone === "home" ? (urls.home ?? urls.away) : (urls.away ?? urls.home));
}

/** False during the server render and hydration, true once the browser owns the page. */
function useMounted() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
const noopSubscribe = () => () => {};

function useNow(everyMs: number) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    // Align ticks to the boundary so the minute flips exactly on time.
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, everyMs - (Date.now() % everyMs));
    };
    // Paint the browser's own time straight away: the server rendered in its time zone, and
    // suppressHydrationWarning would otherwise keep that text until the next tick.
    setNow(Date.now());
    t = setTimeout(tick, everyMs - (Date.now() % everyMs));
    return () => clearTimeout(t);
  }, [everyMs]);
  return now;
}

// ---------------------------------------------------------------- clock

export interface ClockConfig {
  seconds?: boolean;
  zones?: { tz: string; label: string }[];
}

export function ClockWidget({ item, size }: WidgetProps<ClockConfig>) {
  const { prefs, timeZone } = usePrefs();
  const fmt = useFormat();
  const now = useNow(item.config.seconds ? 1000 : 60_000);
  const mounted = useMounted();
  const hour12 = prefs.clock === "auto" ? undefined : prefs.clock === "12";
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: item.config.seconds ? "2-digit" : undefined,
    hour12,
    timeZone,
  }).formatToParts(now);
  const main = parts
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
  const period = parts.find((p) => p.type === "dayPeriod")?.value;
  return (
    // The server doesn't know the viewer's time zone, and React won't patch hydrated text it
    // thinks is already right, so the time only renders once the browser owns the page. The
    // placeholder holds the layout so nothing shifts when it appears.
    <div className={s.clock} data-size={size} style={mounted ? undefined : { visibility: "hidden" }}>
      <div>
        <div className={s.clockTime}>
          {mounted ? main : "00:00"}
          {mounted && period && <small>{period}</small>}
        </div>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div className={s.clockDate}>{mounted ? fmt.date(now, { weekday: true, year: size !== "s" }) : "\u00a0"}</div>
        {!!item.config.zones?.length && (
          <div className={s.zones}>
            {item.config.zones.map((z) => (
              <span key={z.tz} suppressHydrationWarning>
                {z.label}
                <b>
                  {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    hour12,
                    timeZone: z.tz,
                  }).format(now)}
                </b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ClockSettings({ config, onChange }: SettingsProps<ClockConfig>) {
  const [tz, setTz] = React.useState("");
  const [label, setLabel] = React.useState("");
  const zones = config.zones ?? [];
  let valid = false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    valid = !!tz;
  } catch {
    valid = false;
  }
  return (
    <div className={s.form}>
      <Checkbox checked={!!config.seconds} onChange={(v) => onChange({ ...config, seconds: v })}>
        Show seconds
      </Checkbox>
      <Field label="Other time zones" description="E.g. Europe/London. Handy for family abroad.">
        <div className={s.linkEditor}>
          {zones.map((z, i) => (
            <div key={z.tz} className={s.linkEditRow}>
              <span>{z.label}</span>
              <span className="mono">{z.tz}</span>
              <IconButton
                label="Remove"
                size="sm"
                onClick={() =>
                  onChange({
                    ...config,
                    zones: zones.filter((_, j) => j !== i),
                  })
                }
              >
                <Trash />
              </IconButton>
            </div>
          ))}
          <div className={s.linkEditRow}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Mum" aria-label="Label" />
            <Input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/London" aria-label="Time zone" mono />
            <Button
              size="sm"
              icon={<Plus />}
              disabled={!valid || zones.length >= 4}
              onClick={() => {
                onChange({
                  ...config,
                  zones: [
                    ...zones,
                    {
                      tz,
                      label: label || tz.split("/").pop()!.replace(/_/g, " "),
                    },
                  ],
                });
                setTz("");
                setLabel("");
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- status

export function StatusWidget({ size }: WidgetProps) {
  const { viewer } = usePrefs();
  const { data } = useApi<StatusPayload>("/api/status", { refresh: 15_000 });
  if (!data) {
    return (
      <div className={s.status}>
        <Skeleton width="70%" height={20} />
        <Skeleton width="50%" height={12} />
      </div>
    );
  }
  const items = data.findings.slice(0, size === "s" ? 0 : size === "m" || size === "w" ? 3 : 6);
  // Rows that don't fit are clipped whole, so the count always has a way to the full list.
  const showAll = viewer.role === "admin" && data.findings.length > 1;
  return (
    <div className={s.status}>
      <div className={s.statusHead}>
        <span className={s.statusMark} data-tone={data.verdict.tone} aria-hidden />
        <div>
          <p className={s.statusText}>{data.verdict.headline}</p>
          <p className={s.statusDetail}>{data.verdict.detail}</p>
        </div>
      </div>
      {viewer.role === "admin" && items.length > 0 && (
        <ul className={s.statusItems} role="list">
          {items.map((f) => (
            <li key={f.id} className={s.statusItem}>
              <Link href={`/status#${encodeURIComponent(f.id)}`}>
                <span>{f.title}</span>
                <span>{f.remedy?.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {showAll && (
        <Link href="/status" className={s.statusAll}>
          All {data.findings.length} on Status
        </Link>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- apps

export interface AppsConfig {
  show?: "all" | "selected";
  ids?: string[];
  style?: "tiles" | "list";
}

export function AppsWidget({ item, size }: WidgetProps<AppsConfig>) {
  const { data } = useApi<HomeApp[]>("/api/apps", { refresh: 20_000 });
  const { prefs, serverName } = usePrefs();
  const url = useSmartUrl();
  const cfg = item.config;
  if (!data) {
    return (
      <div className={s.apps}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={s.app}>
            <Skeleton width={40} height={40} radius={10} />
            <Skeleton width={56} height={10} />
          </div>
        ))}
      </div>
    );
  }
  let apps = data.filter((a) => a.urls.home || a.urls.away);
  if (cfg.show === "selected" && cfg.ids?.length) {
    const order = new Map(cfg.ids.map((id, i) => [id, i]));
    apps = apps.filter((a) => order.has(a.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else apps = [...apps].sort((a, b) => Number(a.line === "stopped") - Number(b.line === "stopped"));
  if (!apps.length) {
    return (
      <div className={s.center}>
        <div>
          <b>No apps to show yet</b>
          Apps with a web page appear here once they're shared with you.
        </div>
      </div>
    );
  }
  const target = prefs.openLinks === "new" ? "_blank" : undefined;
  const hints = instanceHints(apps);
  if (cfg.style === "list") {
    return (
      <ul className={s.appsList} role="list">
        {apps.map((a) => {
          const href = url(a.urls);
          return (
            <li key={a.id}>
              <a href={href ?? "#"} target={target} rel="noopener noreferrer">
                <AppIcon src={a.icon} name={a.name} size={30} />
                <span className={s.appsListText}>
                  {hints.get(a.id) ? `${shortName(a.name, serverName)} · ${hints.get(a.id)}` : shortName(a.name, serverName)}
                  <span>{a.line === "running" ? (a.description ?? "Running") : a.summary}</span>
                </span>
                <StateLine state={a.line} size={12} />
              </a>
            </li>
          );
        })}
      </ul>
    );
  }
  // A few apps in a big widget get bigger icons, centred, instead of a corner of a mostly empty grid.
  const roomy = apps.length <= (size === "x" ? 10 : size === "l" || size === "t" ? 6 : 0);
  return (
    <div className={s.apps} data-roomy={roomy ? "" : undefined}>
      {apps.map((a) => {
        const href = url(a.urls);
        const down = a.line === "stopped";
        const hint = hints.get(a.id);
        const note = down ? "Stopped" : a.line === "unhealthy" ? "Not working" : a.line === "starting" ? "Starting" : hint;
        return (
          <a
            key={a.id}
            href={href ?? "#"}
            className={s.app}
            target={target}
            rel="noopener noreferrer"
            data-down={down ? "" : undefined}
            data-line={a.line}
            title={a.line !== "running" ? `${a.name}${hint ? ` · ${hint}` : ""}: ${a.summary}` : hint ? `${a.name} · ${hint}` : a.name}
          >
            <span className={s.appIconWrap}>
              <AppIcon src={a.icon} name={a.name} size={roomy ? 56 : 40} />
            </span>
            <span className={s.appName}>{shortName(a.name, serverName)}</span>
            {note && (
              <span className={s.appHint}>
                {a.line !== "running" && <StateLine state={a.line} size={9} />}
                {note}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

export function AppsSettings({ config, onChange }: SettingsProps<AppsConfig>) {
  const { data } = useApi<HomeApp[]>("/api/apps");
  const ids = config.ids ?? [];
  return (
    <div className={s.form}>
      <Field label="Look">
        <Segmented
          aria-label="Look"
          value={config.style ?? "tiles"}
          onChange={(v) => onChange({ ...config, style: v })}
          options={[
            { value: "tiles", label: "Icons" },
            { value: "list", label: "List" },
          ]}
        />
      </Field>
      <Field label="Which apps">
        <Segmented
          aria-label="Which apps"
          value={config.show ?? "all"}
          onChange={(v) =>
            onChange({
              ...config,
              show: v,
              ids: v === "selected" && !ids.length ? (data ?? []).map((a) => a.id) : ids,
            })
          }
          options={[
            { value: "all", label: "All my apps" },
            { value: "selected", label: "Only these" },
          ]}
        />
      </Field>
      {config.show === "selected" && (
        <div className={s.pickGrid}>
          {(data ?? [])
            .filter((a) => a.urls.home || a.urls.away)
            .map((a) => (
              <Checkbox
                key={a.id}
                checked={ids.includes(a.id)}
                onChange={(v) =>
                  onChange({
                    ...config,
                    ids: v ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                  })
                }
              >
                {a.name}
              </Checkbox>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- machine

export function VitalsWidget({ size }: WidgetProps) {
  const { host } = useLive();
  const fmt = useFormat();
  const last = host.at(-1);
  const many = size === "t" || size === "l" || size === "m" || size === "w" || size === "x";
  if (!last) {
    return (
      <div className={s.vitals}>
        <Skeleton height={60} />
        <Skeleton height={60} />
      </div>
    );
  }
  const w = 3 * 60_000;
  const t = (ts: number) => fmt.time(ts, true);
  const tile = (label: string, value: React.ReactNode, series: [number, number][], opts: { max?: number; format: (v: number) => string }) => (
    <div className={s.vital}>
      <span className="label">{label}</span>
      <span className={s.vitalValue}>{value}</span>
      <TimeChart
        series={[{ key: label, label, points: series, area: true }]}
        yMax={opts.max}
        format={opts.format}
        formatTime={t}
        windowMs={w}
        live
        compact
        height={30}
        label={`${label}, last 3 minutes`}
      />
    </div>
  );
  return (
    <div
      className={s.vitals}
      style={
        {
          "--cols": size === "m" || size === "w" ? 4 : 2,
        } as React.CSSProperties
      }
    >
      {tile(
        "CPU",
        <>
          {Math.round(last.cpu)}
          <small>%</small>
        </>,
        host.map((h) => [h.t, h.cpu]),
        { max: 100, format: (v) => `${Math.round(v)}%` },
      )}
      {tile(
        "Memory",
        <>
          {Math.round((last.mem.used / last.mem.total) * 100)}
          <small>%</small>
        </>,
        host.map((h) => [h.t, h.mem.used]),
        { max: last.mem.total, format: (v) => fmt.bytes(v) },
      )}
      {many &&
        tile(
          "Network in",
          <>
            {fmt.rate(last.net.rx).split(" ")[0]}
            <small> {fmt.rate(last.net.rx).split(" ")[1]}</small>
          </>,
          host.map((h) => [h.t, h.net.rx]),
          { format: (v) => fmt.rate(v) },
        )}
      {many &&
        (last.temp !== null
          ? tile(
              "Temperature",
              <>{fmt.temp(last.temp)}</>,
              host.filter((h) => h.temp !== null).map((h) => [h.t, h.temp!]),
              { max: 100, format: (v) => fmt.temp(v) },
            )
          : tile(
              "Disk",
              <>{fmt.rate(last.disk.read + last.disk.write)}</>,
              host.map((h) => [h.t, h.disk.read + h.disk.write]),
              { format: (v) => fmt.rate(v) },
            ))}
    </div>
  );
}

export function StorageWidget() {
  const { data } = useApi<StatusPayload>("/api/status", { refresh: 30_000 });
  // Drives mounted under /mnt or /media read better by what they are ("2.0 TB hard drive") than by
  // a folder named after a serial number; system paths (/, /var, /srv) stay as paths.
  const { data: places } = useApi<{ places: { label: string; path: string; section?: string }[] }>("/api/files/places", { refresh: 300_000 });
  const driveNames = React.useMemo(
    () => new Map((places?.places ?? []).filter((p) => p.section === "drives" && /^\/(mnt|media)\//.test(p.path)).map((p) => [p.path, p.label] as const)),
    [places],
  );
  const fmt = useFormat();
  if (!data)
    return (
      <div className={s.storage}>
        <Skeleton height={30} />
        <Skeleton height={30} />
      </div>
    );
  const rows = data.filesystems.filter((f) => f.size > 512 * 1024 * 1024);
  return (
    <div className={s.storage}>
      {rows.map((f) => (
        <div key={f.mount} className={s.fsRow}>
          <div className={s.fsHead}>
            {driveNames.get(f.mount) ? (
              <span className="truncate" title={f.mount}>
                {driveNames.get(f.mount)}
              </span>
            ) : (
              <span className="mono truncate" title={f.mount}>
                {f.mount}
              </span>
            )}
            <span>{fmt.bytes(f.avail)} free</span>
          </div>
          <UsageBar value={f.pct} attention={85} fault={95} label={`${f.mount} ${Math.round(f.pct)}% used`} />
        </div>
      ))}
    </div>
  );
}

export function SpectrumWidget() {
  const { data } = useApi<StatusPayload>("/api/status", { refresh: 15_000 });
  const fmt = useFormat();
  if (!data)
    return (
      <div className={s.pad}>
        <Skeleton height={80} />
      </div>
    );
  return (
    <div className={s.pad}>
      <Spectrum groups={spectrumGroups(data.apps, data.findings, data.filesystems, (n) => fmt.bytes(n))} height={64} labelRows={2} legend />
    </div>
  );
}

// ---------------------------------------------------------------- bookmarks

export interface BookmarksConfig {
  title?: string;
  links?: { id: string; title: string; url: string }[];
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BookmarksWidget({ item, editing }: WidgetProps<BookmarksConfig>) {
  const { prefs } = usePrefs();
  const links = item.config.links ?? [];
  if (!links.length) {
    return (
      <div className={s.center}>
        <div>
          <b>Your links</b>
          {editing ? "Open this widget's settings to add some." : "Add the sites you open every day. Customise your home page to add them."}
        </div>
      </div>
    );
  }
  return (
    <div className={s.links}>
      {links.map((l) => (
        <a key={l.id} href={l.url} className={s.link} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer">
          <span className={s.linkIcon}>
            <Favicon url={l.url} fallback={(l.title[0] ?? "?").toUpperCase()} />
          </span>
          <span className={s.linkText}>
            <span className={s.linkTitle}>{l.title}</span>
            <span className={s.linkHost}>{hostOf(l.url)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function Favicon({ url, fallback }: { url: string; fallback: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <>{fallback}</>;
  // Fetched by Gluon's server so the sites you bookmark aren't sent to a third-party icon service.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/api/favicon?url=${encodeURIComponent(url)}`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function BookmarksSettings({ config, onChange }: SettingsProps<BookmarksConfig>) {
  const links = config.links ?? [];
  const [title, setTitle] = React.useState("");
  const [url, setUrl] = React.useState("");
  const normalized = /^https?:\/\//i.test(url) ? url : url ? `https://${url}` : "";
  let valid = false;
  try {
    valid = !!normalized && !!new URL(normalized).host;
  } catch {
    valid = false;
  }
  return (
    <div className={s.form}>
      <Field label="Title" optional>
        <Input value={config.title ?? ""} onChange={(e) => onChange({ ...config, title: e.target.value })} placeholder="Links" />
      </Field>
      <Field label="Links">
        <div className={s.linkEditor}>
          {links.map((l, i) => (
            <div key={l.id} className={s.linkEditRow}>
              <Input
                value={l.title}
                onChange={(e) =>
                  onChange({
                    ...config,
                    links: links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                  })
                }
                aria-label="Title"
              />
              <Input
                value={l.url}
                onChange={(e) =>
                  onChange({
                    ...config,
                    links: links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                  })
                }
                aria-label="Address"
                mono
              />
              <IconButton
                label="Remove link"
                size="sm"
                onClick={() =>
                  onChange({
                    ...config,
                    links: links.filter((_, j) => j !== i),
                  })
                }
              >
                <Trash />
              </IconButton>
            </div>
          ))}
          <form
            className={s.linkEditRow}
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              onChange({
                ...config,
                links: [
                  ...links,
                  {
                    id: Math.random().toString(36).slice(2, 10),
                    title: title || hostOf(normalized),
                    url: normalized,
                  },
                ],
              });
              setTitle("");
              setUrl("");
            }}
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name" aria-label="Name" />
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com" aria-label="Address" mono inputMode="url" autoCapitalize="none" />
            <Button type="submit" size="sm" icon={<Plus />} disabled={!valid || links.length >= 40}>
              Add
            </Button>
          </form>
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- notes

export interface NotesConfig {
  text?: string;
  title?: string;
}

export function NotesWidget({ item, update }: WidgetProps<NotesConfig>) {
  const [text, setText] = React.useState(item.config.text ?? "");
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className={s.fill} style={{ position: "relative" }}>
      <textarea
        className={s.notes}
        value={text}
        maxLength={4000}
        placeholder="Jot something down. It saves as you type."
        aria-label="Notes"
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setSaved(false);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            update({ text: v });
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }, 700);
        }}
      />
      <span className={s.saved} data-show={saved ? "" : undefined} aria-live="polite">
        {saved ? "Saved" : ""}
      </span>
    </div>
  );
}

export function NotesSettings({ config, onChange }: SettingsProps<NotesConfig>) {
  return (
    <div className={s.form}>
      <Field label="Title" optional>
        <Input value={config.title ?? ""} onChange={(e) => onChange({ ...config, title: e.target.value })} placeholder="Notes" />
      </Field>
    </div>
  );
}
