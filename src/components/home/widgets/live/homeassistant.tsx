"use client";
// Home Assistant widgets: the things a household picks (lights, scenes, sensors), and who's home.
import * as React from "react";
import {
  Battery75,
  BatteryWarning,
  BrightnessWindow,
  DashboardSpeed,
  Droplet,
  FireFlame,
  Flash,
  Garage,
  HomeShield,
  HomeSimple,
  HomeSimpleDoor,
  HomeTemperatureIn,
  LightBulb,
  LightBulbOn,
  Lock,
  LockSlash,
  MagicWand,
  MusicDoubleNote,
  Pipe3d,
  Play,
  PlugTypeA,
  SingleTapGesture,
  TemperatureHigh,
  Tv,
  User,
  Walking,
  Wind,
  WindowCheck,
} from "iconoir-react";
import type { SettingsProps, WidgetProps } from "../../types";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Checkbox, Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import {
  HA_MAX_PICKED,
  type HaAction,
  type HaIcon,
  type HomeAssistantControlResult,
  type HomeAssistantEntity,
  type HomeAssistantPerson,
  type HomeAssistantPickable,
  type HomeAssistantPickableList,
} from "@/lib/widgets-types";
import { Gate, IntegrationPicker, Quiet, RowsSkeleton, useIntegrationWidget, useSource, useWidgetData, WidgetState } from "./shared";
import { SetUp, spanWords, useFit } from "../kit";
import { TitleField, type IntegrationConfig } from "./media";
import l from "./live.module.css";
import h from "./homeassistant.module.css";

// ---------------------------------------------------------------- words and numbers

const ICONS: Record<HaIcon, React.ComponentType<{ className?: string }>> = {
  light: LightBulb,
  switch: PlugTypeA,
  outlet: PlugTypeA,
  fan: Wind,
  cover: BrightnessWindow,
  blind: BrightnessWindow,
  garage: Garage,
  climate: HomeTemperatureIn,
  lock: Lock,
  scene: MagicWand,
  script: Play,
  button: SingleTapGesture,
  temperature: TemperatureHigh,
  humidity: Droplet,
  power: Flash,
  energy: Flash,
  battery: Battery75,
  door: HomeSimpleDoor,
  window: WindowCheck,
  motion: Walking,
  presence: Walking,
  leak: Droplet,
  smoke: FireFlame,
  media: MusicDoubleNote,
  tv: Tv,
  vacuum: HomeSimple,
  alarm: HomeShield,
  person: User,
  valve: Pipe3d,
  sensor: DashboardSpeed,
};

function iconFor(e: Pick<HomeAssistantEntity, "icon" | "active" | "words">) {
  if (e.icon === "light" && e.active) return LightBulbOn;
  if (e.icon === "lock" && e.active) return LockSlash;
  if (e.icon === "battery" && e.active) return BatteryWarning;
  return ICONS[e.icon];
}

type Fmt = ReturnType<typeof useFormat>;

/** A reading in the person's units: temperatures follow their °C/°F choice, everything else keeps Home Assistant's unit. */
function reading(v: number | null, unit: string | null, fmt: Fmt): string | null {
  if (v === null) return null;
  if (unit === "°C" || unit === "°F") return fmt.temp(unit === "°F" ? ((v - 32) * 5) / 9 : v);
  if (unit === "%") return `${Math.round(v)}%`;
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

/** The one line under a tile's name. Times are left to <Time> so they stay current. */
function stateText(e: HomeAssistantEntity, fmt: Fmt): string | null {
  if (e.unavailable) return e.words;
  if (e.domain === "climate" || e.domain === "water_heater") {
    const now = reading(e.value, e.unit, fmt);
    const target = reading(e.target, e.unit, fmt);
    return [e.words, now, target ? `set to ${target}` : null].filter(Boolean).join(" · ") || null;
  }
  if (e.domain === "humidifier") return [e.words, e.target !== null ? `set to ${Math.round(e.target)}%` : null].filter(Boolean).join(" · ");
  return [e.words, reading(e.value, e.unit, fmt)].filter(Boolean).join(" · ") || null;
}

/** What pressing does, said as the button's name. */
function actionFor(e: HomeAssistantEntity): { action: HaAction; label: string } | null {
  switch (e.control) {
    case "toggle":
      return e.on ? { action: "turn_off", label: `Turn off ${e.name}` } : { action: "turn_on", label: `Turn on ${e.name}` };
    case "cover":
      return e.on ? { action: "close", label: `Close ${e.name}` } : { action: "open", label: `Open ${e.name}` };
    case "run":
      return { action: "run", label: e.domain === "scene" ? `Start the scene ${e.name}` : `Run ${e.name}` };
    case "press":
      return { action: "press", label: `Press ${e.name}` };
    default:
      return null;
  }
}

/** How a tile looks while its press is on its way to Home Assistant. */
function expected(e: HomeAssistantEntity, action: HaAction): HomeAssistantEntity {
  switch (action) {
    case "turn_on":
      return { ...e, on: true, active: true, words: "On", value: null };
    case "turn_off":
      return { ...e, on: false, active: false, words: "Off", value: null };
    case "open":
      return { ...e, on: true, active: true, words: "Opening", value: null };
    case "close":
      return { ...e, on: false, active: false, words: "Closing", value: null };
    default:
      return { ...e, words: e.domain === "scene" ? "Starting" : "Running" };
  }
}

const isAdmin = (role: string) => role === "admin";

// ---------------------------------------------------------------- controls

export interface HaEntitiesConfig extends IntegrationConfig {
  only?: string[];
  /** Admin's unsaved "household can see / press" choices, sent to the connection when the settings are saved. */
  household?: { integration: string; see: Record<string, boolean>; press: Record<string, boolean> };
}

type Pending = { action: HaAction; entity: HomeAssistantEntity };
/** What Home Assistant said after a press, shown until the widget's next answer replaces the one it was pressed on. */
type Settled = { entity: HomeAssistantEntity; seen: number };

/**
 * Presses go straight to Home Assistant; the tile shows the expected state at once and the real one when
 * Home Assistant answers. A failed press puts the tile back and says why.
 */
function useControls(integration: string | null, refetch: () => void, fetchedAt: number) {
  const [pending, setPending] = React.useState<Record<string, Pending>>({});
  const [settled, setSettled] = React.useState<Record<string, Settled>>({});
  const seenRef = React.useRef(fetchedAt);
  React.useLayoutEffect(() => {
    seenRef.current = fetchedAt;
  }, [fetchedAt]);
  const press = React.useCallback(
    async (e: HomeAssistantEntity, action: HaAction, label: string) => {
      if (!integration) return;
      const seen = seenRef.current;
      setPending((p) => ({ ...p, [e.id]: { action, entity: expected(e, action) } }));
      try {
        const r = await api.post<HomeAssistantControlResult>(`/api/integrations/${encodeURIComponent(integration)}/control`, { entity: e.id, action });
        if (r.entity) setSettled((s) => ({ ...s, [e.id]: { entity: r.entity!, seen } }));
        refetch();
      } catch (err) {
        toast.error(`Couldn't ${label.charAt(0).toLowerCase()}${label.slice(1)}`, {
          description: err instanceof ApiError ? err.message : "Home Assistant didn't answer. Check it's running, then try again.",
        });
      } finally {
        setPending((p) => {
          const { [e.id]: _done, ...rest } = p;
          return rest;
        });
      }
    },
    [integration, refetch],
  );
  const view = (e: HomeAssistantEntity) => pending[e.id]?.entity ?? (settled[e.id]?.seen === fetchedAt ? settled[e.id]!.entity : e);
  return { pending, view, press };
}

function EntityTile({
  e,
  fmt,
  canPress,
  busy,
  onPress,
}: {
  e: HomeAssistantEntity;
  fmt: Fmt;
  canPress: boolean;
  busy: boolean;
  onPress: (e: HomeAssistantEntity, action: HaAction, label: string) => void;
}) {
  const Icon = iconFor(e);
  const text = stateText(e, fmt);
  const used = !text && e.lastUsedAt ? e.lastUsedAt : null;
  const title = e.area ? `${e.name} · ${e.area}` : e.name;
  const body = (
    <>
      <Icon className={l.tileIcon} />
      <span className={l.tileName}>{e.name}</span>
      <span className={`${l.tileState} num`}>
        {text ?? (used ? <>Used <Time ts={used} /></> : e.control === "run" ? (e.domain === "scene" ? "Scene" : "Script") : e.control === "press" ? "Button" : " ")}
      </span>
      {e.detail && <span className={`${l.tileState} ${h.detail}`}>{e.detail}</span>}
    </>
  );
  const act = canPress ? actionFor(e) : null;
  if (!act) {
    return (
      <li className={`${l.tile} ${h.tile}`} data-active={e.active ? "" : undefined} data-off={e.unavailable ? "" : undefined} title={title}>
        {body}
      </li>
    );
  }
  return (
    <li className={h.cell}>
      <button
        type="button"
        className={`${l.tile} ${h.tile} ${h.press}`}
        data-active={e.active ? "" : undefined}
        data-off={e.unavailable ? "" : undefined}
        // A switch keeps its name and says on/off with aria-pressed; everything else is named for what it does.
        aria-pressed={e.control === "toggle" ? !!e.on : undefined}
        aria-label={e.control === "toggle" ? e.name : act.label}
        aria-busy={busy || undefined}
        // Busy stays focusable (a disabled button would drop keyboard focus mid-press); only unavailable disables.
        aria-disabled={busy || undefined}
        title={e.area ? `${act.label} · ${e.area}` : act.label}
        disabled={e.unavailable}
        onClick={() => {
          if (!busy) onPress(e, act.action, act.label);
        }}
      >
        {body}
      </button>
    </li>
  );
}

/** "light.kitchen_lamp" → "Kitchen lamp": the person's own pick, the only thing known about something not shared. */
const fromId = (id: string) => {
  const t = id.slice(id.indexOf(".") + 1).replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function NotSharedTile({ id }: { id: string }) {
  return (
    <li className={`${l.tile} ${h.tile}`} data-off="" title="Whoever runs the server hasn't shared this with the household.">
      <Lock className={l.tileIcon} />
      <span className={l.tileName}>{fromId(id)}</span>
      <span className={l.tileState}>Not shared with you</span>
    </li>
  );
}

function TilesSkeleton({ n }: { n: number }) {
  return (
    <ul className={l.tiles} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className={l.tile}>
          <Skeleton width={18} height={18} radius={5} />
          <Skeleton width={`${72 - (i % 3) * 12}%`} height={11} />
          <Skeleton width="40%" height={10} />
        </li>
      ))}
    </ul>
  );
}

export function HaEntities({ item, size, openSettings }: WidgetProps<HaEntitiesConfig>) {
  const only = item.config.only ?? [];
  const q = useIntegrationWidget("homeassistant", "homeassistant.entities", item.config.integration, { only });
  const { viewer } = usePrefs();
  const fmt = useFormat();
  const admin = isAdmin(viewer.role);
  const integrationId = q.source.state === "ok" ? q.source.ref.id : null;
  const retry = q.retry;
  const refetch = React.useCallback(() => retry?.(), [retry]);
  const { pending, view, press } = useControls(integrationId, refetch, q.response?.fetchedAt ?? 0);
  const skeletonCount = size === "s" ? 2 : size === "m" || size === "t" ? 4 : 8;
  return (
    <Gate kind="homeassistant" source={q.source} q={q} openSettings={openSettings} skeleton={<TilesSkeleton n={skeletonCount} />}>
      {(d) => {
        if (!only.length) {
          return (
            <WidgetState title="Pick what to show" action={<SetUp openSettings={openSettings}>Choose things</SetUp>}>
              Lights, switches, scenes and sensors from Home Assistant{d.location ? ` (“${d.location}”)` : ""}.
            </WidgetState>
          );
        }
        if (!d.entities.length && !d.notShared.length) {
          return (
            <WidgetState title="Those things are gone" action={<SetUp openSettings={openSettings}>Choose again</SetUp>}>
              Home Assistant doesn't have what this widget showed any more.
            </WidgetState>
          );
        }
        const shown = d.entities.map(view);
        const withheld = d.notShared.map((id) => <NotSharedTile key={id} id={id} />);
        const tile = (e: HomeAssistantEntity) => (
          <EntityTile key={e.id} e={e} fmt={fmt} canPress={admin || e.household} busy={!!pending[e.id]} onPress={(x, a, lab) => void press(x, a, lab)} />
        );
        const areas = [...new Set(shown.map((e) => e.area))];
        const grouped = areas.length > 1 && (size === "t" || size === "l" || size === "x");
        const foot = d.missing.length ? (
          <p className={`${l.foot} ${h.foot}`}>
            {d.missing.length === 1 ? "1 thing is" : `${d.missing.length} things are`} gone from Home Assistant.{" "}
            {openSettings ? (
              <button type="button" className={h.inlineLink} onClick={openSettings}>
                Choose again
              </button>
            ) : null}
          </p>
        ) : null;
        if (!grouped) {
          return (
            <>
              <ul className={l.tiles} role="list">
                {shown.map(tile)}
                {withheld}
              </ul>
              {foot}
            </>
          );
        }
        return (
          <>
            <div className={l.rooms}>
              {areas.map((area) => (
                <section key={area ?? "_"} aria-label={area ?? "Elsewhere"}>
                  <h3 className={`label ${l.roomLabel} truncate`}>{area ?? "Elsewhere"}</h3>
                  <ul className={l.tiles} role="list">
                    {shown.filter((e) => e.area === area).map(tile)}
                  </ul>
                </section>
              ))}
              {withheld.length > 0 && (
                <section aria-label="Not shared with you">
                  <ul className={l.tiles} role="list">
                    {withheld}
                  </ul>
                </section>
              )}
            </div>
            {foot}
          </>
        );
      }}
    </Gate>
  );
}

// ---------------------------------------------------------------- settings

const DOMAIN_WORD: Record<string, string> = {
  light: "Light",
  switch: "Switch",
  input_boolean: "Switch",
  fan: "Fan",
  cover: "Cover",
  climate: "Thermostat",
  water_heater: "Water heater",
  humidifier: "Humidifier",
  lock: "Lock",
  scene: "Scene",
  script: "Script",
  button: "Button",
  input_button: "Button",
  sensor: "Sensor",
  binary_sensor: "Sensor",
  media_player: "Player",
  vacuum: "Vacuum",
  lawn_mower: "Mower",
  alarm_control_panel: "Alarm",
  input_number: "Number",
  number: "Number",
  valve: "Valve",
};

/** The connection a widget reads from, also when it's on "Automatic". */
function useResolvedId(configured: string | undefined): string | null {
  const s = useSource("homeassistant", configured);
  return s.state === "ok" ? s.ref.id : null;
}

type Sharing = { see: boolean; press: boolean };

function PickRow({
  p,
  shown,
  admin,
  sharing,
  full,
  onShow,
  onSharing,
}: {
  p: HomeAssistantPickable;
  shown: boolean;
  admin: boolean;
  sharing: Sharing;
  full: boolean;
  onShow: (v: boolean) => void;
  onSharing: (v: Sharing) => void;
}) {
  const Icon = ICONS[p.icon];
  return (
    <li className={h.pickRow}>
      <Checkbox checked={shown} disabled={!shown && full} onChange={onShow}>
        <span className={h.pickName}>
          <Icon className={h.pickIcon} aria-hidden />
          <span className="truncate" title={admin ? `${p.name} (${p.id})` : p.name}>
            {p.name}
          </span>
          <span className={h.pickKind}>{DOMAIN_WORD[p.domain] ?? p.domain}</span>
        </span>
      </Checkbox>
      {admin && shown ? (
        <span className={h.pickHousehold}>
          {/* Pressing implies seeing: ticking press ticks see, unticking see unticks press. */}
          <Checkbox checked={sharing.see} onChange={(v) => onSharing({ see: v, press: v && sharing.press })}>
            Household can see
          </Checkbox>
          {p.control && p.memberPressable ? (
            <Checkbox checked={sharing.press} onChange={(v) => onSharing({ see: v || sharing.see, press: v })}>
              Can press
            </Checkbox>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function HaEntitiesSettings({ config, onChange }: SettingsProps<HaEntitiesConfig>) {
  const id = useResolvedId(config.integration);
  const { viewer } = usePrefs();
  const admin = isAdmin(viewer.role);
  const list = useApi<HomeAssistantPickableList>(id ? `/api/integrations/${encodeURIComponent(id)}/entities` : null, { revalidateOnFocus: false });
  const [query, setQuery] = React.useState("");
  const deferred = React.useDeferredValue(query);
  const only = React.useMemo(() => config.only ?? [], [config.only]);
  const draft = config.household?.integration === id ? config.household : null;
  const full = only.length >= HA_MAX_PICKED;

  const visible = React.useMemo(() => {
    const all = list.data?.entities ?? [];
    const terms = deferred.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (p: HomeAssistantPickable) => {
      if (!terms.length) return true;
      const hay = `${p.name} ${p.id} ${p.area ?? ""} ${DOMAIN_WORD[p.domain] ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
    // Picked things first, in their order, then the rest by room.
    const picked = only.map((x) => all.find((p) => p.id === x)).filter((p): p is HomeAssistantPickable => !!p && hit(p));
    const rest = all.filter((p) => !only.includes(p.id) && hit(p));
    // Picks the list doesn't have: gone from Home Assistant, or (for members) not shared with them.
    const unknown = list.data ? only.filter((x) => !all.some((p) => p.id === x)) : [];
    return { picked, rest, unknown };
  }, [list.data, deferred, only]);

  const setShow = (p: HomeAssistantPickable, v: boolean) => {
    const next = v ? [...only, p.id] : only.filter((x) => x !== p.id);
    onChange({ ...config, only: next });
  };
  const setSharing = (p: HomeAssistantPickable, v: Sharing) => {
    if (!id) return;
    onChange({ ...config, household: { integration: id, see: { ...draft?.see, [p.id]: v.see }, press: { ...draft?.press, [p.id]: v.press } } });
  };
  const sharingOf = (p: HomeAssistantPickable): Sharing => ({ see: draft?.see[p.id] ?? p.shared, press: draft?.press[p.id] ?? p.household });

  const groups = React.useMemo(() => {
    const m = new Map<string, HomeAssistantPickable[]>();
    for (const p of visible.rest) {
      const k = p.area ?? "";
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [visible.rest]);

  return (
    <div className={l.form}>
      <IntegrationPicker kind="homeassistant" value={config.integration} onChange={(integration) => onChange({ ...config, integration, only: [], household: undefined })} />
      {id && (
        <Field
          label="What to show"
          description={
            admin
              ? `Up to ${HA_MAX_PICKED}. Others in the household only see what you tick “Household can see”, and only press what you also tick “Can press”. Garage doors, gates, doors, locks and alarms are never theirs to press.`
              : `Up to ${HA_MAX_PICKED}, from the things whoever runs the server shared with the household. Locks, alarms and thermostats can be shown but not changed from Gluon.`
          }
        >
          <div className={h.picker}>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a light, a room, a sensor" aria-label="Find in Home Assistant" type="search" />
            {list.error ? (
              <Notice tone="fault" title="Couldn't load the list from Home Assistant">
                {list.error.message}
              </Notice>
            ) : !list.data ? (
              <div className={h.pickList} aria-busy="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} height={18} width={`${80 - i * 9}%`} />
                ))}
              </div>
            ) : (
              <ul className={h.pickList} role="list">
                {visible.picked.length > 0 && (
                  <li className={h.pickGroup}>
                    <span className="label">On this widget · {only.length}</span>
                    <ul role="list">
                      {visible.picked.map((p) => (
                        <PickRow
                          key={p.id}
                          p={p}
                          shown
                          admin={admin}
                          sharing={sharingOf(p)}
                          full={full}
                          onShow={(v) => setShow(p, v)}
                          onSharing={(v) => setSharing(p, v)}
                        />
                      ))}
                    </ul>
                  </li>
                )}
                {visible.unknown.length > 0 && (
                  <li className={h.pickGroup}>
                    <span className="label">{admin ? "Gone from Home Assistant" : "Not shared with you"}</span>
                    <ul role="list">
                      {visible.unknown.map((x) => (
                        <li key={x} className={h.pickRow}>
                          <Checkbox checked onChange={() => onChange({ ...config, only: only.filter((y) => y !== x) })}>
                            <span className={h.pickName}>
                              <span className="truncate">{fromId(x)}</span>
                            </span>
                          </Checkbox>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                {groups.map(([area, items]) => (
                  <li key={area || "_"} className={h.pickGroup}>
                    <span className="label truncate">{area || (list.data!.areas.length ? "No room" : "Everything")}</span>
                    <ul role="list">
                      {items.map((p) => (
                        <PickRow key={p.id} p={p} shown={false} admin={admin} sharing={sharingOf(p)} full={full} onShow={(v) => setShow(p, v)} onSharing={() => undefined} />
                      ))}
                    </ul>
                  </li>
                ))}
                {!visible.picked.length && !visible.unknown.length && !groups.length && (
                  <li className={h.pickEmpty}>
                    {deferred
                      ? `Nothing ${admin ? "in Home Assistant" : "shared with the household"} matches “${deferred}”.`
                      : admin
                        ? "Home Assistant has nothing Gluon can show yet."
                        : "Nothing from Home Assistant is shared with the household yet. Ask whoever runs the server."}
                  </li>
                )}
              </ul>
            )}
            {list.data?.areasNote && <p className={h.pickNote}>{list.data.areasNote}</p>}
          </div>
        </Field>
      )}
      <TitleField config={config} onChange={onChange} placeholder="Home" />
    </div>
  );
}

const split = (m: Record<string, boolean>) => ({
  allow: Object.keys(m).filter((k) => m[k]),
  deny: Object.keys(m).filter((k) => !m[k]),
});

/** Saving the settings: send an admin's "household can see / press" choices to the connection, then keep only the layout part. */
export async function saveHaEntities(config: HaEntitiesConfig): Promise<HaEntitiesConfig> {
  const { household, ...rest } = config;
  if (!household) return rest;
  const see = split(household.see ?? {});
  const press = split(household.press ?? {});
  if (see.allow.length + see.deny.length + press.allow.length + press.deny.length) {
    await api.put(`/api/integrations/${encodeURIComponent(household.integration)}/household-controls`, { see, press });
  }
  return rest;
}

// ---------------------------------------------------------------- who's home

function useMinute() {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function whereWords(p: HomeAssistantPerson): string {
  return p.where === "home" ? "Home" : p.where === "away" ? "Away" : p.where === "zone" ? `At ${p.place}` : "Not sure";
}

function Since({ p, now }: { p: HomeAssistantPerson; now: number }) {
  if (!p.since || p.where === "unknown") return null;
  const ms = now - p.since;
  if (ms < 0) return null;
  if (ms < 36 * 3600_000) return <> for {spanWords(ms)}</>;
  return (
    <>
      {" "}
      since <Time ts={p.since} kind="date" />
    </>
  );
}

function Avatar({ p }: { p: HomeAssistantPerson }) {
  const [failed, setFailed] = React.useState<string | null>(null);
  const src = p.image && failed !== p.image ? p.image : null;
  const letter = (p.name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={h.avatar} data-away={p.where !== "home" ? "" : undefined} aria-hidden>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        letter
      )}
    </span>
  );
}

export function HaPeople({ item, size }: WidgetProps<IntegrationConfig>) {
  const q = useIntegrationWidget("homeassistant", "homeassistant.people", item.config.integration, {});
  const now = useMinute();
  const [ref, fit] = useFit<HTMLUListElement>(q.data?.people.length ?? 0);
  const { viewer } = usePrefs();
  return (
    <Gate kind="homeassistant" source={q.source} q={q} skeleton={<RowsSkeleton rows={size === "s" ? 2 : 3} thumb={28} />}>
      {(d) => {
        if (!d.people.length) {
          return (
            <Quiet title="No people in Home Assistant">
              {isAdmin(viewer.role)
                ? "Add people in Home Assistant (Settings → People) and give each a phone or tracker. They show up here."
                : "Once whoever runs the server adds people in Home Assistant, they show up here."}
            </Quiet>
          );
        }
        const hidden = d.people.length - fit;
        return (
          <div className={l.col}>
            {size !== "s" && (
              <p className={h.summary}>
                {d.people.length === 1
                  ? `${d.people[0]!.name} is ${d.home ? "home" : "out"}.`
                  : d.home === 0
                    ? "Nobody is home."
                    : d.home === d.people.length
                      ? "Everyone is home."
                      : `${d.home} of ${d.people.length} are home.`}
              </p>
            )}
            <ul ref={ref} className={`${l.list} ${h.people}`} role="list" data-cols={size === "w" || size === "x" ? 2 : undefined}>
              {d.people.map((p) => (
                <li key={p.id} className={h.person}>
                  <StateLine state={p.where === "home" ? "running" : p.where === "unknown" ? "unknown" : "stopped"} size={14} />
                  <Avatar p={p} />
                  <span className={l.rowText}>
                    <span className={l.rowTitle} title={p.name}>
                      {p.name}
                    </span>
                    <span className={`${l.rowMeta} num`} title={p.place ?? undefined}>
                      <span className="truncate">
                        {whereWords(p)}
                        <Since p={p} now={now} />
                      </span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {hidden > 0 && <p className={h.more}>and {hidden} more</p>}
          </div>
        );
      }}
    </Gate>
  );
}

export interface HaPeopleConfig extends IntegrationConfig {
  /** Admin's unsaved "show where people are" choice, sent to the connection when the settings are saved. */
  places?: { integration: string; show: boolean };
}

export function HaPeopleSettings({ config, onChange }: SettingsProps<HaPeopleConfig>) {
  const id = useResolvedId(config.integration);
  const { viewer } = usePrefs();
  const current = useWidgetData("homeassistant.people", id, {}, !!id && isAdmin(viewer.role));
  const draft = config.places?.integration === id ? config.places.show : undefined;
  const show = draft ?? current.data?.places ?? false;
  return (
    <div className={l.form}>
      <IntegrationPicker kind="homeassistant" value={config.integration} onChange={(integration) => onChange({ ...config, integration, places: undefined })} />
      {id && isAdmin(viewer.role) && (
        <SettingRow
          label="Show where people are"
          description="Names places like “Work” for everyone who sees Who's home. Off, it says only Home or Away, and place names never leave the server."
        >
          <Switch
            checked={show}
            disabled={!current.data && draft === undefined}
            onChange={(v) => onChange({ ...config, places: { integration: id, show: v } })}
            aria-label="Show where people are"
          />
        </SettingRow>
      )}
      <TitleField config={config} onChange={onChange} placeholder="Who's home" />
    </div>
  );
}

/** Saving Who's home: send an admin's places choice to the connection, then keep only the layout part. */
export async function saveHaPeople(config: HaPeopleConfig): Promise<HaPeopleConfig> {
  const { places, ...rest } = config;
  if (places) await api.put(`/api/integrations/${encodeURIComponent(places.integration)}/show-places`, { show: places.show });
  return rest;
}
