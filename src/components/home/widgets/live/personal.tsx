"use client";
import * as React from "react";
import { Cloud, CloudSunny, Fog, HalfMoon, MapPin, Rain, Search, Snow, SunLight, Thunderstorm } from "iconoir-react";
import type { SettingsProps, WidgetProps } from "../../types";
import { api, ApiError } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import type { CalendarEvent, GeocodeResult, WeatherData, WeatherIcon as WIcon } from "@/lib/widgets-types";
import { Gate, perSize, Quiet, RowsSkeleton, useDebounced, useWidgetData } from "./shared";
import l from "./live.module.css";

// ---------------------------------------------------------------- weather

export interface WeatherConfig {
  lat?: number;
  lon?: number;
  name?: string | null;
  title?: string;
}

const ICONS: Record<WIcon, React.ComponentType<{ className?: string }>> = {
  clear: SunLight,
  "partly-cloudy": CloudSunny,
  cloudy: Cloud,
  fog: Fog,
  drizzle: Rain,
  rain: Rain,
  "freezing-rain": Rain,
  showers: Rain,
  snow: Snow,
  "snow-showers": Snow,
  thunder: Thunderstorm,
};

function WeatherGlyph({ icon, isDay, className }: { icon: WIcon; isDay: boolean; className?: string }) {
  const I = icon === "clear" && !isDay ? HalfMoon : ICONS[icon];
  return <I className={className} aria-hidden />;
}

/** Temperatures over the next hours, scaled to their own range (works below zero). */
function TempLine({ hours, temp }: { hours: WeatherData["hours"]; temp: (c: number) => string }) {
  const fmt = useFormat();
  if (hours.length < 2) return null;
  const vals = hours.map((h) => h.temperature);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const H = 40;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(2)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(2)}`).join(" ");
  const step = Math.max(1, Math.ceil(hours.length / 6));
  return (
    <figure className={l.tempLine} aria-label={`Next ${hours.length} hours: ${temp(min)} to ${temp(max)}`}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" height={H} aria-hidden>
        <polyline points={pts} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={l.tempTicks} style={{ gridTemplateColumns: `repeat(${hours.length}, 1fr)` }}>
        {hours.map((h, i) => (
          <span key={h.at} className="num" data-show={i % step === 0 ? "" : undefined}>
            {i % step === 0 ? (
              <>
                <b>{temp(h.temperature)}</b>
                {fmt.time(h.at).replace(/:00(?=\s|$)/, "")}
              </>
            ) : null}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function WeatherWidget({ item, size }: WidgetProps<WeatherConfig>) {
  const fmt = useFormat();
  const { lat, lon, name } = item.config;
  const has = typeof lat === "number" && typeof lon === "number";
  const hours = perSize(size, { s: 1, m: 6, t: 8, l: 12, w: 12 }, 6);
  const q = useWidgetData("weather", null, { lat, lon, name: name ?? null, hours }, has);
  if (!has) return <Quiet title="Where are you?">Pick a place in this widget's settings.</Quiet>;
  const temp = (c: number) => fmt.temp(c);
  return (
    <Gate
      q={q}
      subject="The weather"
      skeleton={
        <div className={l.weather} data-size={size}>
          <div className={l.weatherNow}>
            <Skeleton width={90} height={42} />
            <Skeleton width={120} height={12} />
          </div>
        </div>
      }
    >
      {(d) => (
        <div className={l.weather} data-size={size}>
          <div className={l.weatherNow}>
            <div className={l.weatherTemp}>
              <WeatherGlyph icon={d.current.icon} isDay={d.current.isDay} className={l.weatherIcon} />
              <span className="num">{temp(d.current.temperature)}</span>
            </div>
            <div className={l.weatherCond}>
              {d.current.condition}
              {size !== "s" && d.current.feelsLike !== null && Math.abs(d.current.feelsLike - d.current.temperature) >= 2 && <span className="muted"> · feels {temp(d.current.feelsLike)}</span>}
            </div>
            <div className={`${l.weatherRange} num`}>
              <span>H {temp(d.today.high)}</span>
              <span>L {temp(d.today.low)}</span>
              {size !== "s" && d.today.precipitationChance !== null && d.today.precipitationChance >= 20 && <span>{d.today.precipitationChance}% rain</span>}
            </div>
          </div>
          {(size === "m" || size === "w") && (
            <ol className={l.hours} role="list" aria-label="Next hours">
              {d.hours.map((h) => (
                <li key={h.at}>
                  <span className="num">{fmt.time(h.at).replace(/:00(?=\s|$)/, "")}</span>
                  <WeatherGlyph icon={h.icon} isDay={h.isDay} className={l.hourIcon} />
                  <b className="num">{temp(h.temperature)}</b>
                </li>
              ))}
            </ol>
          )}
          {(size === "t" || size === "l") && (
            <div className={l.weatherMore}>
              <TempLine hours={d.hours} temp={temp} />
              <div className={l.weatherFoot}>
                {d.tomorrow && (
                  <span>
                    <span className="label">Tomorrow</span>
                    <span className="num">
                      {d.tomorrow.condition}, {temp(d.tomorrow.high)} / {temp(d.tomorrow.low)}
                    </span>
                  </span>
                )}
                {size === "l" && d.today.sunrise && d.today.sunset && (
                  <span>
                    <span className="label">Daylight</span>
                    <span className="num">
                      {fmt.time(d.today.sunrise)} – {fmt.time(d.today.sunset)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Gate>
  );
}

export function WeatherSettings({ config, onChange }: SettingsProps<WeatherConfig>) {
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<GeocodeResult["results"] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<GeocodeResult>(`/api/widgets/geocode?q=${encodeURIComponent(q.trim())}`);
      setResults(r.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't search for places.");
    } finally {
      setBusy(false);
    }
  };
  const locate = () => {
    if (!("geolocation" in navigator)) return setError("This browser can't share its location.");
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setBusy(false);
        onChange({ ...config, lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100, name: "Your location" });
      },
      () => {
        setBusy(false);
        setError("Location wasn't shared. Search for a place instead.");
      },
      { timeout: 10_000, maximumAge: 600_000 },
    );
  };
  return (
    <div className={l.form}>
      <Field label="Place" description={config.name ? undefined : "Search for a town or city."}>
        <form className={l.searchRow} onSubmit={search}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Town or city" aria-label="Search for a place" autoComplete="off" />
          <Button type="submit" icon={<Search />} loading={busy} disabled={q.trim().length < 2}>
            Search
          </Button>
        </form>
      </Field>
      {error && <Notice tone="fault">{error}</Notice>}
      {results && (
        <ul className={l.places} role="list">
          {results.length === 0 && <li className="muted">No places match “{q}”.</li>}
          {results.map((r) => {
            const where = [r.region, r.country].filter(Boolean).join(", ");
            const selected = config.lat === r.lat && config.lon === r.lon;
            return (
              <li key={r.id}>
                <button type="button" className={l.place} aria-pressed={selected} onClick={() => onChange({ ...config, lat: r.lat, lon: r.lon, name: r.name })}>
                  <MapPin aria-hidden />
                  <span>
                    {r.name}
                    {where && <small>{where}</small>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={l.placeNow}>
        {typeof config.lat === "number" ? (
          <span>
            Showing <b>{config.name ?? "a place"}</b>{" "}
            <span className="mono muted">
              {config.lat.toFixed(2)}, {config.lon?.toFixed(2)}
            </span>
          </span>
        ) : (
          <span className="muted">No place chosen yet.</span>
        )}
        <Button size="sm" variant="ghost" icon={<MapPin />} onClick={locate} disabled={busy}>
          Use my location
        </Button>
      </div>
      <Field label="Title" optional>
        <Input value={config.title ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, title: e.target.value || undefined })} placeholder={config.name ?? "Weather"} />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- calendar

export interface CalendarConfig {
  url?: string;
  days?: 3 | 7 | 14;
  title?: string;
  calName?: string | null;
}

function dayKey(ts: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}

function useViewerTz() {
  const { timeZone } = usePrefs();
  return timeZone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
}

export function CalendarWidget({ item, size }: WidgetProps<CalendarConfig>) {
  const fmt = useFormat();
  const tz = useViewerTz();
  const { url } = item.config;
  const days = item.config.days ?? 7;
  const limit = perSize(size, { m: 4, t: 8, l: 12 }, 8);
  const q = useWidgetData("calendar", null, { url, days, limit, tz }, !!url);
  if (!url) return <Quiet title="Add a calendar">Paste your calendar's private link (ICS) in this widget's settings.</Quiet>;
  return (
    <Gate q={q} subject="The calendar" skeleton={<RowsSkeleton rows={size === "m" ? 2 : 4} />}>
      {(d) => {
        if (!d.events.length) return <Quiet title="Nothing coming up">{`No events in the next ${days === 3 ? "3 days" : days === 14 ? "2 weeks" : "week"}.`}</Quiet>;
        const today = dayKey(Date.now(), tz);
        const tomorrow = dayKey(Date.now() + 86_400_000, tz);
        const groups = new Map<string, CalendarEvent[]>();
        for (const e of d.events) {
          let k = e.allDay ? e.startDate! : dayKey(e.start, tz);
          if (k < today) k = today; // started earlier, still going
          groups.set(k, [...(groups.get(k) ?? []), e]);
        }
        const label = (k: string, first: CalendarEvent) =>
          k === today ? "Today" : k === tomorrow ? "Tomorrow" : fmt.date(first.allDay && first.startDate === k ? first.start : dayStart(first, k), { weekday: true });
        return (
          <div className={l.agenda}>
            {[...groups.entries()].map(([k, evs]) => (
              <section key={k} className={l.day} aria-label={label(k, evs[0]!)}>
                <h3 className={`label ${l.dayLabel}`}>{label(k, evs[0]!)}</h3>
                <ul role="list">
                  {evs.map((e) => (
                    <li key={e.id} className={l.event} data-now={e.ongoing ? "" : undefined}>
                      <span className={`${l.eventTime} num`}>
                        {e.ongoing && !e.allDay ? "Now" : e.allDay ? "All day" : fmt.time(e.start)}
                      </span>
                      <span className={l.eventText}>
                        <span className={l.rowTitle} title={e.title}>
                          {e.title}
                        </span>
                        {(e.location || (e.allDay && e.endDate && e.endDate !== e.startDate) || (e.ongoing && !e.allDay && e.end)) && (
                          <span className={l.rowMeta} title={e.location ?? undefined}>
                            {[
                              e.ongoing && !e.allDay && e.end ? `until ${fmt.time(e.end)}` : null,
                              e.allDay && e.endDate && e.endDate !== e.startDate ? `until ${fmt.date(e.end! - 1, { weekday: true })}` : null,
                              e.location,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        );
      }}
    </Gate>
  );
}

/** A timestamp inside day `k` for labelling (noon avoids zone edge cases). */
function dayStart(e: CalendarEvent, k: string) {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  return e.allDay ? Date.UTC(y, m - 1, d, 12) : e.start;
}

export function CalendarSettings({ config, onChange }: SettingsProps<CalendarConfig>) {
  const tz = useViewerTz();
  const [url, setUrl] = React.useState(config.url ?? "");
  const settled = useDebounced(config.url);
  const valid = /^(https?|webcals?):\/\/\S+\.\S+$/i.test(settled ?? "");
  const preview = useWidgetData("calendar", null, { url: settled, days: 14, limit: 3, tz }, valid);
  const calName = preview.data?.name ?? null;
  React.useEffect(() => {
    if (preview.data && calName !== (config.calName ?? null)) onChange({ ...config, calName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calName, preview.data]);
  return (
    <div className={l.form}>
      <Field
        label="Calendar link (ICS)"
        description="Google Calendar: Settings → your calendar → “Secret address in iCal format”. Apple iCloud: share the calendar publicly and copy the link. Only you see this link."
        error={preview.error && !preview.data ? preview.error.message : null}
      >
        <Input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            onChange({ ...config, url: e.target.value.trim() || undefined });
          }}
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          mono
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
        />
      </Field>
      {valid && preview.loading && <Skeleton height={14} width="50%" />}
      {preview.data && (
        <p className={l.found}>
          Found {preview.data.name ? <b>{preview.data.name}</b> : "a calendar"}
          {preview.data.events.length ? ` · next: ${preview.data.events[0]!.title}` : " · nothing in the next two weeks"}
        </p>
      )}
      <Field label="Look ahead">
        <Segmented
          aria-label="Look ahead"
          value={String(config.days ?? 7) as "3" | "7" | "14"}
          onChange={(v) => onChange({ ...config, days: Number(v) as 3 | 7 | 14 })}
          options={[
            { value: "3", label: "3 days" },
            { value: "7", label: "A week" },
            { value: "14", label: "Two weeks" },
          ]}
        />
      </Field>
      <Field label="Title" optional>
        <Input value={config.title ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, title: e.target.value || undefined })} placeholder={config.calName ?? "Calendar"} />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- feed

export interface FeedConfig {
  url?: string;
  title?: string;
  feedTitle?: string | null;
  summaries?: boolean;
}

function host(u: string | null) {
  if (!u) return null;
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function FeedWidget({ item, size }: WidgetProps<FeedConfig>) {
  const { prefs } = usePrefs();
  const { url } = item.config;
  const limit = perSize(size, { m: 3, t: 6, l: 7, w: 4 }, 5);
  const q = useWidgetData("feed", null, { url, limit }, !!url);
  const summaries = item.config.summaries !== false && (size === "t" || size === "l");
  if (!url) return <Quiet title="Add a feed">Paste an RSS or Atom address in this widget's settings.</Quiet>;
  return (
    <Gate q={q} subject="The feed" skeleton={<RowsSkeleton rows={size === "m" || size === "w" ? 2 : 4} />}>
      {(d) =>
        d.items.length === 0 ? (
          <Quiet title="No posts yet">New posts from {d.title ?? "this feed"} appear here.</Quiet>
        ) : (
          <ul className={l.feed} role="list" data-cols={size === "w" ? 2 : undefined}>
            {d.items.map((it) => (
              <li key={it.id}>
                <a
                  className={l.feedItem}
                  href={it.url ?? d.siteUrl ?? url}
                  target={prefs.openLinks === "new" ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  title={it.title}
                >
                  <span className={l.feedTitle}>{it.title}</span>
                  {summaries && it.summary && <span className={l.feedSummary}>{it.summary}</span>}
                  <span className={l.rowMeta}>
                    {[it.author, host(it.url) ?? d.title].filter(Boolean).join(" · ")}
                    {it.publishedAt && (
                      <>
                        {" · "}
                        <Time ts={it.publishedAt} />
                      </>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )
      }
    </Gate>
  );
}

export function FeedSettings({ config, onChange }: SettingsProps<FeedConfig>) {
  const [url, setUrl] = React.useState(config.url ?? "");
  const settled = useDebounced(config.url);
  const valid = /^https?:\/\/\S+\.\S+$/i.test(settled ?? "");
  const preview = useWidgetData("feed", null, { url: settled, limit: 3 }, valid);
  const feedTitle = preview.data?.title ?? null;
  React.useEffect(() => {
    if (preview.data && feedTitle !== (config.feedTitle ?? null)) onChange({ ...config, feedTitle });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedTitle, preview.data]);
  return (
    <div className={l.form}>
      <Field label="Feed address" description="RSS, Atom or JSON Feed. Many sites have one at /feed or /rss." error={preview.error && !preview.data ? preview.error.message : null}>
        <Input
          value={url}
          onChange={(e) => {
            const v = e.target.value.trim();
            setUrl(e.target.value);
            onChange({ ...config, url: v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : undefined });
          }}
          placeholder="https://example.com/feed"
          mono
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
        />
      </Field>
      {valid && preview.loading && <Skeleton height={14} width="50%" />}
      {preview.data && (
        <p className={l.found}>
          Found {preview.data.title ? <b>{preview.data.title}</b> : "a feed"}
          {preview.data.items[0] ? ` · latest: ${preview.data.items[0].title}` : ""}
        </p>
      )}
      <Checkbox checked={config.summaries !== false} onChange={(v) => onChange({ ...config, summaries: v })}>
        Show a short summary in the tall sizes
      </Checkbox>
      <Field label="Title" optional>
        <Input value={config.title ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, title: e.target.value || undefined })} placeholder={config.feedTitle ?? "News"} />
      </Field>
    </div>
  );
}
