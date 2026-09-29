"use client";
// Admin widgets that read this machine: which disk fills up first, what the processor draws, and what's scheduled.
import * as React from "react";
import Link from "next/link";
import { registerWidget } from "../widgetStore";
import type { SettingsProps, WidgetProps } from "../types";
import { useApi } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { AffixInput, Field, Input } from "@/components/ui/Field";
import { Skeleton, UsageBar } from "@/components/ui/Surface";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { Sparkline } from "@/components/charts/TimeChart";
import type { PowerData, ScheduleData, ScheduleItem, SpaceData, SpaceDisk } from "@/lib/home-widgets-types";
import { Age, WidgetState, useDayStart, useDriveNames, useFit } from "./kit";
import { Preview } from "../previews";
import m from "./machine.module.css";

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={m.link} onClick={onClick}>
      Try again
    </button>
  );
}

function Rows({ n = 3 }: { n?: number }) {
  return (
    <div className={m.body} aria-busy="true" aria-label="Loading">
      <Skeleton width="60%" height={18} />
      <Skeleton width="40%" height={12} />
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={m.skelRow}>
          <Skeleton width={`${70 - i * 10}%`} height={12} />
          <Skeleton height={5} radius={3} />
        </div>
      ))}
    </div>
  );
}

// ================================================================ Running out of space

/** "in about 9 days", "in about 5 hours", "in about 3 months", or null past a year (not worth worrying about). */
function fillsIn(days: number): string | null {
  if (days < 1) return `in about ${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 1.5) return "in about a day";
  if (days < 45) return `in about ${Math.round(days)} days`;
  if (days < 365) return `in about ${Math.round(days / 30)} months`;
  return null;
}

function diskLine(d: SpaceDisk): LineState {
  if (d.trend !== "filling" || d.daysToFull === null) return d.pct >= 95 ? "unhealthy" : "running";
  if (d.daysToFull < 2) return "unhealthy";
  if (d.daysToFull < 14) return "attention";
  return "running";
}

function SpaceWidget({ size }: WidgetProps) {
  const { data, error, mutate } = useApi<SpaceData>("/api/widgets/space", { refresh: 10 * 60_000 });
  const fmt = useFormat();
  const names = useDriveNames();
  const disks = data?.disks ?? [];
  const [listRef, fit] = useFit<HTMLUListElement>(size === "s" ? 0 : disks.length);
  if (!data) {
    if (error) {
      return (
        <WidgetState line="unknown" title="Can't forecast the disks" action={<Retry onClick={() => void mutate()} />}>
          {error.status === 403 ? "Only admins can see this." : error.message}
        </WidgetState>
      );
    }
    return <Rows n={size === "s" ? 0 : 2} />;
  }
  if (!disks.length) return <WidgetState title="No disks to watch">Gluon hasn&apos;t measured any disks yet. They appear a minute after it starts.</WidgetState>;
  const nameOf = (mount: string) => names.get(mount) ?? mount;
  const filling = disks.filter((d) => d.trend === "filling" && d.daysToFull !== null && fillsIn(d.daysToFull));
  const learning = disks.every((d) => d.trend === "learning");
  const lead = filling[0];
  const words = lead ? fillsIn(lead.daysToFull!)! : null;
  const line: LineState = lead ? diskLine(lead) : learning ? "starting" : "running";
  const hidden = size === "s" ? 0 : disks.length - fit;
  const trendText = (d: SpaceDisk) => {
    if (d.trend === "learning") return `Learning · ${fmt.bytes(d.avail)} free`;
    const rate = d.perDay !== null ? `${fmt.bytes(Math.abs(d.perDay))} a day` : "";
    if (d.trend === "filling") return d.daysToFull !== null && fillsIn(d.daysToFull) ? `Full ${fillsIn(d.daysToFull)} · +${rate}` : `Growing slowly · +${rate}`;
    if (d.trend === "shrinking") return `Shrinking · −${rate}`;
    return `Steady · ${fmt.bytes(d.avail)} free`;
  };
  return (
    <div className={m.body}>
      <p className={m.headline}>
        <StateLine state={line} size={18} />
        <span>
          {lead ? (
            <>
              <span className={names.has(lead.mount) ? undefined : "mono"}>{nameOf(lead.mount)}</span> fills {words}
            </>
          ) : learning ? (
            "Still learning how fast disks fill"
          ) : (
            "No disk is filling up"
          )}
        </span>
      </p>
      <p className={m.sub}>
        {lead
          ? `At this rate: +${fmt.bytes(lead.perDay!)} a day, ${fmt.bytes(lead.avail)} left.${filling.length > 1 ? ` ${filling.length - 1} more ${filling.length === 2 ? "disk is" : "disks are"} filling.` : ""}`
          : learning
            ? "Gluon needs about half a day of history. Check back later."
            : "Based on the last week. Nothing will run out at this rate."}
      </p>
      {size !== "s" && (
        <ul className={m.list} role="list" ref={listRef}>
          {disks.map((d, i) => (
            <li key={d.mount} className={m.disk} aria-hidden={i >= fit || undefined}>
              <span className={m.diskHead}>
                <span className={`${m.diskName} ${names.has(d.mount) ? "" : "mono"}`} title={d.mount}>
                  {nameOf(d.mount)}
                </span>
                <span className={`${m.diskFig} num`}>{Math.round(d.pct)}%</span>
              </span>
              <UsageBar value={d.pct} attention={85} fault={95} label={`${nameOf(d.mount)}: ${Math.round(d.pct)}% used`} />
              <span className={m.diskMeta} data-line={diskLine(d)}>
                {trendText(d)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/storage?tab=space" className={m.link}>
        {hidden > 0 ? `${hidden} more in Storage` : "See what's using space"}
      </Link>
    </div>
  );
}

registerWidget({
  type: "server.space",
  name: "Running out of space",
  description: "Which disk fills up first at the last week's rate, and roughly when. Or that none will.",
  category: "Server",
  sizes: ["s", "m", "t", "l"],
  defaultSize: "m",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Space",
  Component: SpaceWidget,
  preview: <Preview of="space" />,
});

// ================================================================ Power

interface PowerConfig {
  /** Price of a kilowatt-hour, in the currency below. */
  price?: number;
  currency?: string;
}

/** A sensible currency symbol from the browser's region until the admin picks one. */
function guessCurrency(): string {
  if (typeof navigator === "undefined") return "";
  const region = (navigator.language.split("-")[1] ?? "").toUpperCase();
  if (region === "GB") return "£";
  if (["US", "CA", "AU", "NZ", "SG", "HK", "MX"].includes(region)) return "$";
  if (["JP", "CN"].includes(region)) return "¥";
  if (["SE", "NO", "DK", "IS"].includes(region)) return "kr ";
  if (region === "CH") return "CHF ";
  if (region === "IN") return "₹";
  if (["DE", "FR", "ES", "IT", "NL", "BE", "AT", "IE", "PT", "FI", "GR", "LU", "SK", "SI", "EE", "LV", "LT", "MT", "CY", "HR"].includes(region)) return "€";
  return "";
}

function money(v: number, currency: string) {
  const digits = v >= 100 ? 0 : 2;
  return `${currency}${v.toFixed(digits)}`;
}

function PowerWidget({ item, size, openSettings }: WidgetProps<PowerConfig>) {
  const dayStart = useDayStart();
  const { data, error, mutate } = useApi<PowerData>(`/api/widgets/power?dayStart=${dayStart}`, { refresh: 10_000 });
  const fmt = useFormat();
  const price = item.config.price && item.config.price > 0 ? item.config.price : null;
  const currency = item.config.currency ?? guessCurrency();
  if (!data) {
    if (error) {
      return (
        <WidgetState line="unknown" title="Can't read the power meter" action={<Retry onClick={() => void mutate()} />}>
          {error.status === 403 ? "Only admins can see this." : error.message}
        </WidgetState>
      );
    }
    return (
      <div className={m.power} data-size={size} aria-busy="true" aria-label="Loading">
        <Skeleton width={90} height={30} />
        <Skeleton height={28} />
        <Skeleton width="60%" height={12} />
      </div>
    );
  }
  if (!data.available) return <WidgetState title="No power meter here">{data.reason}</WidgetState>;
  const series = size === "s" || size === "m" ? data.hour : data.day;
  const span = size === "s" || size === "m" ? "the last hour" : "the last day";
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthKwh = data.avgWatts !== null ? (data.avgWatts * 24 * daysInMonth) / 1000 : null;
  const todayKwh = data.todayWh / 1000;
  const peak = series.length ? Math.max(...series.map(([, w]) => w)) : null;
  const stale = data.at === null;
  return (
    <div className={m.power} data-size={size}>
      <div className={m.powerHead}>
        <span className={m.figure}>
          {data.watts !== null ? (data.watts < 10 ? data.watts.toFixed(1) : Math.round(data.watts)) : "—"}
          <small> W</small>
        </span>
        <span className={m.powerNow}>{stale ? "Not measuring right now" : "Processor, now"}</span>
      </div>
      {series.length > 1 ? (
        <Sparkline points={series.map(([, w]) => w)} height={size === "s" ? 24 : 32} tone="ink" label={`Processor power over ${span}${peak !== null ? `, peaking at ${Math.round(peak)} W` : ""}`} />
      ) : (
        <p className={m.learning}>A line of the last hour fills in here as Gluon measures.</p>
      )}
      <dl className={m.stats}>
        <div>
          <dt>Today</dt>
          <dd className="num" title={data.todayCoverage < 0.95 ? `Measured for ${Math.round(data.todayCoverage * 100)}% of today` : undefined}>
            {todayKwh < 1 ? `${Math.round(data.todayWh)} Wh` : `${todayKwh.toFixed(2)} kWh`}
          </dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd className="num" title={monthKwh !== null ? `About ${monthKwh.toFixed(1)} kWh at the ${data.avgHours >= 48 ? "last week's" : "average so far"} ${Math.round(data.avgWatts!)} W` : undefined}>
            {monthKwh === null ? "—" : price ? `≈ ${money(monthKwh * price, currency)}` : `≈ ${monthKwh.toFixed(monthKwh < 10 ? 1 : 0)} kWh`}
          </dd>
        </div>
        {(size === "t" || size === "w") && data.avgWatts !== null && (
          <div>
            <dt>Average</dt>
            <dd className="num">{Math.round(data.avgWatts)} W</dd>
          </div>
        )}
      </dl>
      {size !== "s" && (
        <p className={m.note}>
          Processor package only; the rest of the machine isn&apos;t measured.
          {!price && openSettings && (
            <>
              {" "}
              <button type="button" className={m.link} onClick={openSettings}>
                Add your electricity price
              </button>{" "}
              to see the cost.
            </>
          )}
          {data.todayCoverage < 0.95 && ` Today is measured for ${Math.round(data.todayCoverage * 100)}% of the day so far.`}
        </p>
      )}
      <Age at={data.at} expectMs={60_000} className={m.age} />
    </div>
  );
}

function PowerSettings({ config, onChange }: SettingsProps<PowerConfig>) {
  const [text, setText] = React.useState(config.price ? String(config.price) : "");
  return (
    <div className={m.form}>
      <Field label="Electricity price" description="Per kilowatt-hour, from your bill. The monthly figure becomes a cost.">
        <AffixInput
          before={(config.currency ?? guessCurrency()).trim() || "¤"}
          after="per kWh"
          inputMode="decimal"
          value={text}
          placeholder="0.28"
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value.replace(",", "."));
            onChange({ ...config, price: Number.isFinite(v) && v > 0 && v < 100 ? v : undefined });
          }}
        />
      </Field>
      <Field label="Currency symbol" description="Shown before the cost, e.g. £, $, € or kr.">
        <Input value={config.currency ?? ""} maxLength={4} placeholder={guessCurrency().trim() || "£"} onChange={(e) => onChange({ ...config, currency: e.target.value.trim() || undefined })} />
      </Field>
    </div>
  );
}

registerWidget<PowerConfig>({
  type: "server.power",
  name: "Power",
  description: "What the processor draws now, energy used today, and roughly what it costs a month.",
  category: "Server",
  sizes: ["s", "m", "t", "w"],
  defaultSize: "s",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Power",
  Component: PowerWidget,
  Settings: PowerSettings,
  preview: <Preview of="power" />,
});

// ================================================================ Coming up

function ScheduleRow({ it }: { it: ScheduleItem }) {
  const fmt = useFormat();
  const failed = it.lastResult === "failed";
  const when = it.next;
  return (
    <>
      <span className={`${m.when} num`}>{when ? (it.approx ? `~${fmt.time(when)}` : fmt.time(when)) : "—"}</span>
      <span className={m.what}>
        <span className={m.whatName} title={it.unit ?? it.detail ?? it.name}>
          {it.name}
        </span>
        <span className={m.whatMeta}>
          {failed && (
            <span className={m.failed}>
              <StateLine state="unhealthy" size={9} /> Last run failed ·{" "}
            </span>
          )}
          {when ? <Time ts={when} /> : "Not scheduled"}
          {it.detail ? ` · ${it.detail}` : it.unit ? <span className="mono"> · {it.unit.replace(/\.timer$/, "")}</span> : null}
        </span>
      </span>
    </>
  );
}

/** "Today", "Tomorrow", or the weekday and date: one heading per day. */
function dayLabel(ts: number, today: number, fmt: ReturnType<typeof useFormat>) {
  const d = Math.floor((ts - today) / 86_400_000);
  if (d <= 0) return "Today";
  if (d === 1) return "Tomorrow";
  return fmt.date(ts, { weekday: true });
}

function ScheduleWidget({ size }: WidgetProps) {
  const { data, error, mutate } = useApi<ScheduleData>("/api/widgets/schedule", { refresh: 60_000 });
  const fmt = useFormat();
  const today = useDayStart();
  const items = data?.available ? data.items.filter((i) => i.next !== null) : [];
  const [listRef, fit] = useFit<HTMLOListElement>(size === "s" ? 0 : items.length);
  if (!data) {
    if (error) {
      return (
        <WidgetState line="unknown" title="Can't read the schedule" action={<Retry onClick={() => void mutate()} />}>
          {error.status === 403 ? "Only admins can see this." : error.message}
        </WidgetState>
      );
    }
    return <Rows n={size === "s" ? 0 : 3} />;
  }
  if (!data.available) return <WidgetState title="No schedule to read">{data.reason}</WidgetState>;
  if (!items.length) return <WidgetState title="Nothing scheduled">This machine has no timers waiting to run.</WidgetState>;
  const first = items[0]!;
  const failed = data.items.filter((i) => i.lastResult === "failed");
  if (size === "s") {
    return (
      <div className={m.body}>
        <span className="label">Next</span>
        <p className={m.headline}>
          <span className={m.clamp}>{first.name}</span>
        </p>
        <p className={m.sub}>
          <Time ts={first.next!} /> · {first.approx ? "around " : ""}
          {fmt.time(first.next!)}
        </p>
        {failed.length > 0 && (
          <p className={m.failedLine}>
            <StateLine state="unhealthy" size={10} /> {failed.length === 1 ? `${failed[0]!.name}: last run failed` : `${failed.length} jobs failed last time`}
          </p>
        )}
      </div>
    );
  }
  const hidden = items.length - fit;
  let lastDay = "";
  return (
    <div className={m.body}>
      <ol className={m.schedule} role="list" ref={listRef}>
        {items.map((it, i) => {
          const day = dayLabel(it.next!, today, fmt);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <li key={it.id} className={m.item} data-day={showDay ? "" : undefined} aria-hidden={i >= fit || undefined}>
              {showDay && <span className={`label ${m.day}`}>{day}</span>}
              <ScheduleRow it={it} />
            </li>
          );
        })}
      </ol>
      <Link href="/system?tab=services" className={m.link}>
        {hidden > 0 ? `${hidden} more in System` : "Services in System"}
      </Link>
    </div>
  );
}

registerWidget({
  type: "server.schedule",
  name: "Coming up",
  description: "What the server will do on its own next: updates, log tidying, disk checks, certificate renewals.",
  category: "Server",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "t",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Coming up",
  Component: ScheduleWidget,
  preview: <Preview of="schedule" />,
});

