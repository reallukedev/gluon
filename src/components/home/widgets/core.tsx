"use client";
import * as React from "react";
import Link from "next/link";
import { Plus, Trash } from "iconoir-react";
import type { WidgetProps, SettingsProps } from "../types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { StateLine } from "@/components/ui/StateLine";
import { TimeChart } from "@/components/charts/TimeChart";
import { UsageBar, Skeleton } from "@/components/ui/Surface";
import { Field, Input, Checkbox } from "@/components/ui/Field";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Age, SetUp, WidgetState, useDriveNames, useFit } from "./kit";
import { Spectrum } from "@/components/spectrum/Spectrum";
import { spectrumGroups } from "./spectrum-groups";
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
            {item.config.zones.slice(0, size === "s" ? 1 : size === "m" ? 3 : 4).map((z, i) => (
              <span key={`${z.tz}:${i}`} suppressHydrationWarning title={z.tz}>
                <span className={s.zoneLabel}>{z.label}</span>
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
  const admin = viewer.role === "admin";
  const { data, error, mutate } = useApi<StatusPayload>("/api/status", { refresh: 15_000 });
  const findings = admin && size !== "s" ? (data?.findings ?? []) : [];
  // Only rows that fit whole are shown; the link below counts the rest, so the headline's number always adds up.
  const [listRef, fit] = useFit<HTMLUListElement>(findings.length);
  if (!data) {
    if (error?.status === 403) {
      return (
        <WidgetState title="Status is for admins here">Whoever runs the server hasn&apos;t shared it with the household.</WidgetState>
      );
    }
    if (error) {
      return (
        <WidgetState
          line="unknown"
          title="Can't check the server"
          action={
            <Button size="sm" variant="ghost" onClick={() => void mutate()}>
              Try again
            </Button>
          }
        >
          {admin ? error.message : "Gluon didn't answer just now. It tries again on its own."}
        </WidgetState>
      );
    }
    return (
      <div className={s.status} aria-busy="true" aria-label="Checking the server">
        <div className={s.statusHead}>
          <Skeleton width={2} height={22} radius={0} />
          <div style={{ flex: 1, display: "grid", gap: 7 }}>
            <Skeleton width="70%" height={18} />
            <Skeleton width="45%" height={12} />
          </div>
        </div>
      </div>
    );
  }
  const total = admin ? data.findings.length : 0;
  const hidden = total - (size === "s" ? 0 : fit);
  return (
    <div className={s.status}>
      <div className={s.statusHead}>
        <span className={s.statusMark} data-tone={data.verdict.tone} aria-hidden />
        <div className={s.statusWords}>
          <p className={s.statusText}>{data.verdict.headline}</p>
          <p className={s.statusDetail}>
            {data.verdict.detail}
            <Age at={data.checkedAt} expectMs={60_000} className={s.statusAge} />
          </p>
        </div>
      </div>
      {findings.length > 0 && (
        <ul className={s.statusItems} role="list" ref={listRef}>
          {findings.map((f, i) => (
            <li key={f.id} className={s.statusItem} aria-hidden={i >= fit || undefined}>
              <Link href={`/status#${encodeURIComponent(f.id)}`} tabIndex={i >= fit ? -1 : undefined}>
                <StateLine state={f.severity === "fault" ? "unhealthy" : f.severity === "attention" ? "attention" : "unknown"} size={11} />
                <span title={f.title}>{f.title}</span>
                {f.remedy?.label && <span>{f.remedy.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {admin && total > 0 && (hidden > 0 || size === "s") && (
        <Link href="/status" className={s.statusAll}>
          {hidden === total ? `See ${total === 1 ? "it" : `all ${total}`} on Status` : `${hidden} more on Status`}
        </Link>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- machine

export function VitalsWidget({ size }: WidgetProps) {
  const { host, status } = useLive();
  const { viewer } = usePrefs();
  const fmt = useFormat();
  const last = host.at(-1);
  const many = size === "t" || size === "l" || size === "m" || size === "w" || size === "x";
  const cols = size === "m" || size === "w" ? 4 : 2;
  if (!last) {
    if (status === "offline") {
      return (
        <WidgetState line="unknown" title="Waiting for the server">
          Live readings stopped. They pick up again as soon as Gluon answers.
        </WidgetState>
      );
    }
    return (
      <div className={s.vitals} style={{ "--cols": cols } as React.CSSProperties} aria-busy="true" aria-label="Loading live readings">
        {Array.from({ length: many ? 4 : 2 }, (_, i) => (
          <div key={i} className={s.vital}>
            <Skeleton width={48} height={10} />
            <Skeleton width={56} height={24} />
            <Skeleton height={30} />
          </div>
        ))}
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
    <div className={s.vitals} style={{ "--cols": cols } as React.CSSProperties} data-offline={status === "offline" ? "" : undefined}>
      {status === "offline" && <Age at={last.t} expectMs={10_000} className={s.vitalsAge} />}
      {tile(
        viewer.role === "admin" ? "CPU" : "Processor",
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

export function StorageWidget({ size }: WidgetProps) {
  const { data, error, mutate } = useApi<StatusPayload>("/api/status", { refresh: 30_000 });
  const driveNames = useDriveNames();
  const fmt = useFormat();
  const rows = (data?.filesystems ?? []).filter((f) => f.size > 512 * 1024 * 1024);
  const [listRef, fit] = useFit<HTMLDivElement>(rows.length);
  if (!data) {
    if (error) {
      return (
        <WidgetState
          line="unknown"
          title="Can't read the disks"
          action={
            <Button size="sm" variant="ghost" onClick={() => void mutate()}>
              Try again
            </Button>
          }
        >
          {error.message}
        </WidgetState>
      );
    }
    return (
      <div className={s.storage} aria-busy="true" aria-label="Loading disks">
        {[0, 1, 2].map((i) => (
          <div key={i} className={s.fsRow}>
            <div className={s.fsHead}>
              <Skeleton width={`${46 - i * 8}%`} height={11} />
              <Skeleton width={56} height={11} />
            </div>
            <Skeleton height={6} radius={3} />
          </div>
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return <WidgetState title="No disks to show">Gluon hasn&apos;t measured any disks yet. They appear here a minute after it starts.</WidgetState>;
  }
  const hidden = rows.length - fit;
  return (
    <div className={s.storageWrap}>
      <div className={s.storage} ref={listRef}>
        {rows.map((f, i) => {
          const name = driveNames.get(f.mount);
          return (
            <div key={f.mount} className={s.fsRow} aria-hidden={i >= fit || undefined}>
              <div className={s.fsHead}>
                {name ? (
                  <span className="truncate" title={f.mount}>
                    {name}
                  </span>
                ) : (
                  <span className="mono truncate" title={f.mount}>
                    {f.mount}
                  </span>
                )}
                <span>
                  {fmt.bytes(f.avail)} free{size !== "s" && <span className={s.fsOf}> of {fmt.bytes(f.size)}</span>}
                </span>
              </div>
              <UsageBar value={f.pct} attention={85} fault={95} label={`${name ?? f.mount}: ${Math.round(f.pct)}% used`} />
            </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <Link href="/storage" className={s.moreLink}>
          {hidden} more in Storage
        </Link>
      )}
    </div>
  );
}

export function SpectrumWidget() {
  const { data, error } = useApi<StatusPayload>("/api/status", { refresh: 15_000 });
  const fmt = useFormat();
  if (!data && error) return <WidgetState line="unknown" title="Can't draw the server right now">{error.message}</WidgetState>;
  if (!data)
    return (
      <div className={s.pad} aria-busy="true" aria-label="Loading">
        <div className={s.spectrumSkel}>
          {Array.from({ length: 28 }, (_, i) => (
            <i key={i} style={{ height: `${55 + ((i * 37) % 45)}%` }} />
          ))}
        </div>
      </div>
    );
  if (!data.apps.length && !data.filesystems.length) {
    return (
      <WidgetState
        title="Nothing running yet"
        action={
          <LinkButton href="/apps" size="sm">
            Open Apps
          </LinkButton>
        }
      >
        Every app and disk on the server shows up here as a line.
      </WidgetState>
    );
  }
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

export function BookmarksWidget({ item, openSettings }: WidgetProps<BookmarksConfig>) {
  const { prefs } = usePrefs();
  const links = item.config.links ?? [];
  if (!links.length) {
    return (
      <WidgetState title="No links yet" action={<SetUp openSettings={openSettings}>Add links</SetUp>}>
        Keep the sites you open every day one click away.
      </WidgetState>
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
            <span className={s.linkTitle} title={l.title}>
              {l.title}
            </span>
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
