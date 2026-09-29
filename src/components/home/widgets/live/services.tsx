"use client";
import * as React from "react";
import { AirConditioner, ArrowDown, ArrowUp, Garage, LightBulb, LightBulbOn, Lock, LockSlash, PlugTypeA, TemperatureHigh, Droplet, Tv, Walking, Wind, WindowCheck, HomeSimpleDoor } from "iconoir-react";
import type { SettingsProps, WidgetProps } from "../../types";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import type { AccessoryKind, HomebridgeAccessory, JsonFieldValue, SlskdTransfer } from "@/lib/widgets-types";
import { Gate, IntegrationPicker, perSize, Quiet, RowsSkeleton, StatsSkeleton, useIntegrationWidget, useSource, useWidgetData, WidgetState } from "./shared";
import { SetUp } from "../kit";
import { TitleField, type IntegrationConfig } from "./media";
import l from "./live.module.css";

// ---------------------------------------------------------------- slskd

function TransferRow({ t }: { t: SlskdTransfer }) {
  const fmt = useFormat();
  const Dir = t.direction === "download" ? ArrowDown : ArrowUp;
  let status: React.ReactNode;
  if (t.state === "active") {
    status = [`${Math.round(t.percent)}%`, t.speedBps ? fmt.rate(t.speedBps) : null, t.remainingSec !== null ? `${fmt.duration(t.remainingSec, 1)} left` : null].filter(Boolean).join(" · ");
  } else if (t.state === "queued") {
    status = t.placeInQueue ? `Waiting · #${t.placeInQueue} in line` : "Waiting";
  } else if (t.state === "done") {
    status = "Finished";
  } else {
    status = <span className={l.faultText}>Didn't finish · {t.stateLabel.replace(/^Completed,\s*/, "")}</span>;
  }
  return (
    <li className={l.transfer}>
      <Dir className={l.dirIcon} aria-label={t.direction === "download" ? "Download" : "Upload"} />
      <div className={l.rowText}>
        <span className={l.rowTitle} title={t.folder ? `${t.folder} / ${t.file}` : t.file}>
          {t.file}
        </span>
        <span className={l.rowMeta}>
          {t.user}
          {t.folder ? ` · ${t.folder}` : ""}
        </span>
        {t.state === "active" || t.state === "queued" ? (
          <span className={l.progressRow}>
            <span className={l.progress} role="progressbar" aria-label={`${t.file}: ${Math.round(t.percent)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.percent)}>
              <span className={l.progressFill} data-paused={t.state === "queued" ? "" : undefined} style={{ width: `${t.percent}%` }} />
            </span>
          </span>
        ) : null}
        <span className={`${l.rowMeta} num`}>{status}</span>
      </div>
    </li>
  );
}

export function SlskdTransfers({ item, size }: WidgetProps<IntegrationConfig>) {
  const fmt = useFormat();
  const limit = perSize(size, { m: 3, t: 6, l: 6, w: 4 }, 5);
  const q = useIntegrationWidget("slskd", "slskd.transfers", item.config.integration, { limit });
  return (
    <Gate kind="slskd" source={q.source} q={q} skeleton={<RowsSkeleton rows={2} />}>
      {(d) => (
        <div className={l.col}>
          <div className={`${l.transferHead} num`}>
            <span>
              <ArrowDown className={l.inlineIcon} aria-hidden />
              {d.downloads.active ? `${d.downloads.active} downloading · ${fmt.rate(d.downloads.speedBps)}` : d.downloads.queued ? `${d.downloads.queued} waiting` : "No downloads"}
            </span>
            <span>
              <ArrowUp className={l.inlineIcon} aria-hidden />
              {d.uploads.active ? `${d.uploads.active} · ${fmt.rate(d.uploads.speedBps)}` : "Idle"}
            </span>
            {d.connected === false && (
              <span className={l.faultText}>
                <StateLine state="stopped" size={11} /> Not connected to Soulseek
              </span>
            )}
          </div>
          {d.items.length === 0 ? (
            <Quiet title="No transfers">Downloads and uploads in progress show up here.</Quiet>
          ) : (
            <ul className={l.list} role="list" data-cols={size === "w" ? 2 : undefined}>
              {d.items.map((t) => (
                <TransferRow key={t.id} t={t} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Gate>
  );
}

// ---------------------------------------------------------------- Homebridge

export interface HomebridgeConfig extends IntegrationConfig {
  only?: string[];
}

const ICON: Record<AccessoryKind, React.ComponentType<{ className?: string }>> = {
  light: LightBulb,
  switch: PlugTypeA,
  outlet: PlugTypeA,
  fan: Wind,
  thermostat: TemperatureHigh,
  temperature: TemperatureHigh,
  humidity: Droplet,
  contact: WindowCheck,
  motion: Walking,
  lock: Lock,
  cover: Garage,
  tv: Tv,
  air: AirConditioner,
  other: HomeSimpleDoor,
};

function accessoryState(a: HomebridgeAccessory, temp: (c: number) => string): { text: string; active: boolean } {
  switch (a.kind) {
    case "light":
      return { text: a.on ? (a.brightness !== null ? `On · ${Math.round(a.brightness)}%` : "On") : "Off", active: !!a.on };
    case "thermostat":
      return {
        text: [a.temperature !== null ? temp(a.temperature) : null, a.targetTemperature !== null ? `set to ${temp(a.targetTemperature)}` : null].filter(Boolean).join(" · ") || "—",
        active: !!a.on,
      };
    case "temperature":
      return { text: a.temperature !== null ? temp(a.temperature) : "—", active: true };
    case "humidity":
      return { text: a.humidity !== null ? `${Math.round(a.humidity)}%` : "—", active: true };
    case "contact":
      return { text: a.contact === "open" ? "Open" : a.contact === "closed" ? "Closed" : "—", active: a.contact === "open" };
    case "motion":
      return { text: a.motion ? "Motion" : "Still", active: !!a.motion };
    case "lock":
      return { text: a.locked === true ? "Locked" : a.locked === false ? "Unlocked" : "—", active: a.locked === false };
    case "cover":
      return { text: a.position !== null ? (a.position === 0 ? "Closed" : a.position === 100 ? "Open" : `${Math.round(a.position)}% open`) : "—", active: (a.position ?? 0) > 0 };
    default:
      return { text: a.on === null ? "—" : a.on ? "On" : "Off", active: !!a.on };
  }
}

function AccessoryTile({ a }: { a: HomebridgeAccessory }) {
  const fmt = useFormat();
  const st = accessoryState(a, (c) => fmt.temp(c));
  const Icon = a.kind === "light" && a.on ? LightBulbOn : a.kind === "lock" && a.locked === false ? LockSlash : ICON[a.kind];
  return (
    <li className={l.tile} data-active={st.active ? "" : undefined} title={a.room ? `${a.name} · ${a.room}` : a.name}>
      <Icon className={l.tileIcon} />
      <span className={l.tileName}>{a.name}</span>
      <span className={`${l.tileState} num`}>
        {st.text}
        {a.humidity !== null && a.kind !== "humidity" ? ` · ${Math.round(a.humidity)}%` : ""}
      </span>
      {a.batteryLow && <span className={l.attnText}>Battery low</span>}
    </li>
  );
}

export function HomebridgeAccessories({ item, size }: WidgetProps<HomebridgeConfig>) {
  const only = item.config.only ?? [];
  const q = useIntegrationWidget("homebridge", "homebridge.accessories", item.config.integration, { only });
  const { viewer } = usePrefs();
  return (
    <Gate
      kind="homebridge"
      source={q.source}
      q={q}
      skeleton={
        <ul className={l.tiles} aria-busy="true">
          {Array.from({ length: size === "m" || size === "w" ? 4 : 6 }, (_, i) => (
            <li key={i} className={l.tile}>
              <Skeleton width={18} height={18} radius={5} />
              <Skeleton width="70%" height={11} />
              <Skeleton width="40%" height={10} />
            </li>
          ))}
        </ul>
      }
    >
      {(d) => {
        if (!d.accessories.length) {
          return (
            <Quiet title={only.length ? "Those accessories are gone" : "No accessories to show"}>
              {only.length
                ? "Pick accessories again in this widget's settings."
                : viewer.role === "admin"
                  ? "If Homebridge has accessories, turn on Insecure Mode in its settings so it shares their state."
                  : "Accessories from Homebridge appear here."}
            </Quiet>
          );
        }
        const grouped = !only.length && d.rooms.length > 1 && size !== "m" && size !== "w";
        if (!grouped) {
          return (
            <ul className={l.tiles} role="list">
              {d.accessories.map((a) => (
                <AccessoryTile key={a.id} a={a} />
              ))}
            </ul>
          );
        }
        return (
          <div className={l.rooms}>
            {[...d.rooms, null].map((room) => {
              const list = d.accessories.filter((a) => a.room === room);
              if (!list.length) return null;
              return (
                <section key={room ?? "_"} aria-label={room ?? "Other"}>
                  <h3 className={`label ${l.roomLabel}`}>{room ?? "Other"}</h3>
                  <ul className={l.tiles} role="list">
                    {list.map((a) => (
                      <AccessoryTile key={a.id} a={a} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        );
      }}
    </Gate>
  );
}

export function HomebridgeSettings({ config, onChange }: SettingsProps<HomebridgeConfig>) {
  const source = useSource("homebridge", config.integration);
  const all = useWidgetData("homebridge.accessories", source.state === "ok" ? source.ref.id : null, { only: [] }, source.state === "ok");
  const only = config.only ?? [];
  return (
    <div className={l.form}>
      <IntegrationPicker kind="homebridge" value={config.integration} onChange={(integration) => onChange({ ...config, integration, only: [] })} />
      {source.state === "ok" && (
        <>
          <Field label="Which accessories">
            <Segmented
              aria-label="Which accessories"
              value={only.length ? "some" : "all"}
              onChange={(v) => onChange({ ...config, only: v === "all" ? [] : (all.data?.accessories ?? []).map((a) => a.id) })}
              options={[
                { value: "all", label: "All" },
                { value: "some", label: "Only these" },
              ]}
            />
          </Field>
          {only.length > 0 && (
            <div className={l.pickGrid}>
              {!all.data && <Skeleton height={60} />}
              {all.data?.accessories.map((a) => (
                <Checkbox
                  key={a.id}
                  checked={only.includes(a.id)}
                  onChange={(v) => {
                    const next = v ? [...only, a.id] : only.filter((x) => x !== a.id);
                    if (next.length) onChange({ ...config, only: next });
                  }}
                >
                  {a.name}
                  {a.room ? <span className="muted"> · {a.room}</span> : null}
                </Checkbox>
              ))}
            </div>
          )}
        </>
      )}
      <TitleField config={config} onChange={onChange} placeholder="Home" />
    </div>
  );
}

// ---------------------------------------------------------------- generic JSON

function FieldValue({ f }: { f: JsonFieldValue }) {
  const fmt = useFormat();
  const v = f.value;
  if (v === null) return <span className="muted">—</span>;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
  const t = n !== null ? (n > 1e11 ? n : n * 1000) : typeof v === "string" ? Date.parse(v) : NaN;
  switch (f.format) {
    case "bytes":
      return <>{n !== null ? fmt.bytes(n) : String(v)}</>;
    case "percent":
      return <>{n !== null ? fmt.percent(n > 0 && n <= 1 && !Number.isInteger(n) ? n * 100 : n) : String(v)}</>;
    case "duration":
      return <>{n !== null ? fmt.duration(n) : String(v)}</>;
    case "number":
      return <>{n !== null ? n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 1 }) : String(v)}</>;
    case "date":
      return Number.isFinite(t) ? <Time ts={t} kind="dateTime" /> : <>{String(v)}</>;
    case "relative":
      return Number.isFinite(t) ? <Time ts={t} /> : <>{String(v)}</>;
    case "boolean":
      return <>{f.display}</>;
    default:
      return <>{String(v)}</>;
  }
}

export function JsonFields({ item, size }: WidgetProps<IntegrationConfig>) {
  const { viewer } = usePrefs();
  const q = useIntegrationWidget("generic-json", "json.fields", item.config.integration, {});
  return (
    <Gate kind="generic-json" source={q.source} q={q} skeleton={<StatsSkeleton n={size === "s" ? 2 : 4} />}>
      {(d) =>
        d.fields.length === 0 ? (
          <Quiet title="No values set up">
            {viewer.role === "admin" ? "Choose which values to show in Settings → Connected apps." : "Whoever runs the server hasn't picked any values yet."}
          </Quiet>
        ) : (
          <div className={l.stats} data-cols={size === "s" || size === "t" ? 2 : 4}>
            {d.fields.map((f, i) => (
              <div key={`${f.label}:${i}`} className={l.stat} title={f.missing ? "Nothing was found at this value's path." : undefined}>
                <span className="label truncate">{f.label}</span>
                <span className={`${l.statValue} num truncate`} data-text={f.format === "text" ? "" : undefined}>
                  <FieldValue f={f} />
                </span>
              </div>
            ))}
          </div>
        )
      }
    </Gate>
  );
}

// ---------------------------------------------------------------- link status

export interface LinkStatusConfig {
  url?: string;
  label?: string;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LinkStatus({ item, size, openSettings }: WidgetProps<LinkStatusConfig>) {
  const url = item.config.url;
  const q = useWidgetData("link.status", null, { url }, !!url);
  const { prefs } = usePrefs();
  if (!url)
    return (
      <WidgetState title="Which address?" action={<SetUp openSettings={openSettings}>Add an address</SetUp>}>
        Gluon checks it every minute and says whether it answers.
      </WidgetState>
    );
  return (
    <Gate q={q} subject={hostOf(url)} openSettings={openSettings} skeleton={<RowsSkeleton rows={1} />}>
      {(d) => (
        <div className={l.status} data-size={size}>
          <div className={l.statusHead}>
            <StateLine state={d.up ? "running" : "stopped"} size={16} />
            <a className={l.statusName} href={url} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer" title={url}>
              {item.config.label || hostOf(url)}
            </a>
          </div>
          <div className={l.statusBody}>
            {d.up && d.latencyMs !== null ? (
              <span className={`${l.statValue} num`}>
                {d.latencyMs}
                <small> ms</small>
              </span>
            ) : (
              <span className={l.statusDown}>{d.up ? "Up" : "Down"}</span>
            )}
            <span className={l.rowMeta}>{d.message}</span>
          </div>
        </div>
      )}
    </Gate>
  );
}

export function LinkStatusSettings({ config, onChange }: SettingsProps<LinkStatusConfig>) {
  const [url, setUrl] = React.useState(config.url ?? "");
  const normalise = (v: string) => (v && !/^https?:\/\//i.test(v) ? `http://${v}` : v);
  return (
    <div className={l.form}>
      <Field label="Address to check" description="Gluon's server checks it every minute, so addresses on your home network work too.">
        <Input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            onChange({ ...config, url: normalise(e.target.value.trim()) || undefined });
          }}
          placeholder="http://192.168.1.1"
          mono
          inputMode="url"
          autoCapitalize="none"
        />
      </Field>
      <Field label="Name" optional>
        <Input value={config.label ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, label: e.target.value || undefined })} placeholder={config.url ? hostOf(config.url) : "Router"} />
      </Field>
    </div>
  );
}

