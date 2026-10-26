// Home Assistant: turning REST state objects into the shapes Home widgets draw, and deciding who may press what.
// Pure (no I/O) so the mapping and the permission rules can be tested against recorded responses.
import type { HaAction, HaControl, HaIcon, HomeAssistantEntity, HomeAssistantPerson, HomeAssistantPickable } from "@/lib/widgets-types";
import { HA_ACTIONS, HA_ENTITY_ID } from "@/lib/widgets-types";

/** One item of GET /api/states. */
export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/**
 * Domains Gluon shows. Everything else stays out, on purpose: cameras and images carry access tokens in their
 * attributes, device trackers are raw locations (people cover that), automations and selects are configuration.
 */
export const SHOWN_DOMAINS = new Set([
  "light",
  "switch",
  "fan",
  "cover",
  "climate",
  "lock",
  "scene",
  "script",
  "input_boolean",
  "input_button",
  "button",
  "sensor",
  "binary_sensor",
  "media_player",
  "vacuum",
  "alarm_control_panel",
  "person",
  "input_number",
  "number",
  "water_heater",
  "humidifier",
  "valve",
  "lawn_mower",
]);

/** What can be pressed from Gluon, per domain. Locks, alarms, valves and thermostats are look-only by design. */
const CONTROL: Record<string, HaControl> = {
  light: "toggle",
  switch: "toggle",
  fan: "toggle",
  input_boolean: "toggle",
  humidifier: "toggle",
  cover: "cover",
  scene: "run",
  script: "run",
  button: "press",
  input_button: "press",
};

export const domainOf = (id: string) => id.slice(0, id.indexOf("."));
export const controlOf = (domain: string): HaControl | null => CONTROL[domain] ?? null;

/** Device classes that open a way into the house. */
const ENTRANCES = new Set(["garage", "garage_door", "gate", "door", "lock"]);

/**
 * Household members may look at these but never press them, even if an admin shared them: anything without a
 * control (locks, alarms, thermostats), and covers or other things that open a garage, a gate or a door.
 * Admins can still press the covers.
 */
export function memberLookOnly(domain: string, deviceClass: string | null | undefined): boolean {
  if (!controlOf(domain)) return true;
  return !!deviceClass && ENTRANCES.has(deviceClass);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ts = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "armed_home" → "Armed home". */
const words = (s: string) => cap(s.replace(/_/g, " "));

const UNAVAILABLE = new Set(["unavailable", "unknown"]);

/** Binary sensor words by device class: [on, off]. */
const BINARY: Record<string, [string, string]> = {
  door: ["Open", "Closed"],
  garage_door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  lock: ["Unlocked", "Locked"],
  motion: ["Motion", "Clear"],
  occupancy: ["Someone's there", "Clear"],
  presence: ["Home", "Away"],
  moisture: ["Wet", "Dry"],
  smoke: ["Smoke", "Clear"],
  gas: ["Gas", "Clear"],
  carbon_monoxide: ["Carbon monoxide", "Clear"],
  safety: ["Unsafe", "Safe"],
  problem: ["Problem", "OK"],
  battery: ["Low", "Normal"],
  battery_charging: ["Charging", "Not charging"],
  plug: ["Plugged in", "Unplugged"],
  power: ["Powered", "No power"],
  connectivity: ["Connected", "Disconnected"],
  running: ["Running", "Not running"],
  light: ["Light", "Dark"],
  sound: ["Sound", "Quiet"],
  vibration: ["Vibration", "Still"],
  heat: ["Hot", "Normal"],
  cold: ["Cold", "Normal"],
  tamper: ["Tampered", "Clear"],
  update: ["Update available", "Up to date"],
};

function iconOf(domain: string, deviceClass: string | null): HaIcon {
  switch (domain) {
    case "light":
      return "light";
    case "switch":
      return deviceClass === "outlet" ? "outlet" : "switch";
    case "input_boolean":
      return "switch";
    case "fan":
      return "fan";
    case "cover":
      return deviceClass === "garage" || deviceClass === "gate" ? "garage" : deviceClass === "door" ? "door" : deviceClass === "window" ? "window" : "blind";
    case "climate":
    case "water_heater":
      return "climate";
    case "humidifier":
      return "humidity";
    case "lock":
      return "lock";
    case "scene":
      return "scene";
    case "script":
      return "script";
    case "button":
    case "input_button":
      return "button";
    case "media_player":
      return deviceClass === "tv" ? "tv" : "media";
    case "vacuum":
    case "lawn_mower":
      return "vacuum";
    case "alarm_control_panel":
      return "alarm";
    case "person":
      return "person";
    case "valve":
      return "valve";
    case "binary_sensor":
      switch (deviceClass) {
        case "door":
        case "garage_door":
        case "opening":
          return "door";
        case "window":
          return "window";
        case "motion":
        case "occupancy":
        case "presence":
          return "motion";
        case "moisture":
          return "leak";
        case "smoke":
        case "gas":
        case "carbon_monoxide":
          return "smoke";
        case "battery":
        case "battery_charging":
          return "battery";
        case "plug":
        case "power":
          return "power";
        default:
          return "sensor";
      }
    default:
      switch (deviceClass) {
        case "temperature":
          return "temperature";
        case "humidity":
        case "moisture":
          return "humidity";
        case "power":
        case "current":
        case "voltage":
          return "power";
        case "energy":
        case "energy_storage":
          return "energy";
        case "battery":
          return "battery";
        default:
          return "sensor";
      }
  }
}

export function displayName(s: HaState): string {
  const a = s.attributes ?? {};
  const name = str(a.friendly_name);
  if (name) return name;
  // "light.living_room_lamp" → "Living room lamp"
  return cap(s.entity_id.slice(s.entity_id.indexOf(".") + 1).replace(/_/g, " "));
}

interface MapOptions {
  area: string | null;
  /** An admin shared it with the household to look at. */
  shared: boolean;
  /** An admin let the household press it (only counts where members may press at all). */
  press: boolean;
  /** The home's temperature unit from /api/config ("°C"); thermostats don't report their own. */
  tempUnit?: string | null;
}

/** One state object → the entity a widget draws. Only named fields cross over: attributes are never passed through. */
export function toEntity(s: HaState, o: MapOptions): HomeAssistantEntity {
  const a = s.attributes ?? {};
  const domain = domainOf(s.entity_id);
  const deviceClass = str(a.device_class);
  const state = String(s.state ?? "");
  const unavailable = UNAVAILABLE.has(state);
  const control = controlOf(domain);
  const e: HomeAssistantEntity = {
    id: s.entity_id,
    domain,
    name: displayName(s),
    area: o.area,
    icon: iconOf(domain, deviceClass),
    words: null,
    value: null,
    unit: null,
    target: null,
    detail: null,
    active: false,
    unavailable,
    control,
    on: null,
    shared: o.shared || o.press,
    household: o.press && !memberLookOnly(domain, deviceClass),
    changedAt: ts(s.last_changed),
    lastUsedAt: null,
  };
  if (unavailable) {
    e.words = state === "unknown" ? "No reading" : "Unavailable";
    return e;
  }
  switch (domain) {
    case "light":
    case "switch":
    case "input_boolean":
    case "fan":
    case "humidifier": {
      e.on = state === "on";
      e.active = e.on;
      e.words = e.on ? "On" : "Off";
      if (domain === "light" && e.on) {
        const b = num(a.brightness);
        if (b !== null) [e.value, e.unit] = [Math.round((b / 255) * 100), "%"];
      }
      if (domain === "fan" && e.on) {
        const p = num(a.percentage);
        if (p !== null) [e.value, e.unit] = [Math.round(p), "%"];
      }
      if (domain === "humidifier") [e.target, e.unit] = [num(a.humidity), "%"];
      break;
    }
    case "cover":
    case "valve": {
      const open = state === "open" || state === "opening";
      e.on = domain === "cover" ? open : null;
      e.active = open;
      e.words = { open: "Open", closed: "Closed", opening: "Opening", closing: "Closing" }[state] ?? words(state);
      const p = num(a.current_position);
      if (p !== null && p > 0 && p < 100) [e.value, e.unit] = [Math.round(p), "%"];
      break;
    }
    case "climate":
    case "water_heater": {
      const action = str(a.hvac_action);
      const ACTION: Record<string, string> = { heating: "Heating", cooling: "Cooling", drying: "Drying", fan: "Fan", idle: "Idle", off: "Off", preheating: "Warming up", defrosting: "Defrosting" };
      e.words = state === "off" ? "Off" : action ? (ACTION[action] ?? words(action)) : words(state);
      e.active = action === "heating" || action === "cooling" || action === "drying";
      e.value = num(a.current_temperature);
      e.target = state === "off" ? null : num(a.temperature);
      e.unit = o.tempUnit ?? null;
      break;
    }
    case "lock": {
      e.words = { locked: "Locked", unlocked: "Unlocked", locking: "Locking", unlocking: "Unlocking", jammed: "Jammed", open: "Open", opening: "Opening" }[state] ?? words(state);
      e.active = state !== "locked";
      break;
    }
    case "scene":
    case "button":
    case "input_button": {
      // The state of a scene or button is the time it was last used.
      e.lastUsedAt = ts(state);
      break;
    }
    case "script": {
      e.on = state === "on";
      e.active = e.on;
      e.words = e.on ? "Running" : null;
      e.lastUsedAt = ts(a.last_triggered);
      break;
    }
    case "binary_sensor": {
      const on = state === "on";
      const pair = BINARY[deviceClass ?? ""];
      e.words = pair ? pair[on ? 0 : 1] : on ? "On" : "Off";
      e.active = on;
      break;
    }
    case "media_player": {
      e.words = { playing: "Playing", paused: "Paused", idle: "Idle", off: "Off", on: "On", standby: "Standby", buffering: "Loading" }[state] ?? words(state);
      e.active = state === "playing";
      if (state === "playing" || state === "paused") {
        const title = str(a.media_title);
        const artist = str(a.media_artist) ?? str(a.media_series_title);
        e.detail = title ? (artist ? `${artist} · ${title}` : title) : null;
      }
      break;
    }
    case "vacuum":
    case "lawn_mower": {
      e.words = { cleaning: "Cleaning", mowing: "Mowing", docked: "Docked", returning: "Going home", idle: "Idle", paused: "Paused", error: "Stuck" }[state] ?? words(state);
      e.active = state === "cleaning" || state === "mowing" || state === "returning";
      break;
    }
    case "alarm_control_panel": {
      e.words =
        {
          disarmed: "Off",
          armed_home: "On, home",
          armed_away: "On, away",
          armed_night: "On, night",
          armed_vacation: "On, holiday",
          armed_custom_bypass: "On",
          arming: "Turning on",
          disarming: "Turning off",
          pending: "About to go off",
          triggered: "Going off",
        }[state] ?? words(state);
      e.active = state !== "disarmed";
      break;
    }
    case "person": {
      e.words = state === "home" ? "Home" : state === "not_home" ? "Away" : state;
      e.active = state === "home";
      break;
    }
    default: {
      // sensor, number, input_number
      const n = num(state);
      if (n !== null) {
        e.value = n;
        e.unit = str(a.unit_of_measurement);
      } else {
        // Text sensors: keep short states, cut long ones (they're shown in a tile).
        e.words = state.length > 40 ? `${state.slice(0, 39)}…` : words(state);
      }
    }
  }
  return e;
}

export function toPickable(s: HaState, area: string | null, sharing: { shared: boolean; press: boolean }): HomeAssistantPickable {
  const domain = domainOf(s.entity_id);
  const deviceClass = str(s.attributes?.device_class);
  const memberPressable = !memberLookOnly(domain, deviceClass);
  return {
    id: s.entity_id,
    name: displayName(s),
    domain,
    area,
    icon: iconOf(domain, deviceClass),
    control: controlOf(domain),
    shared: sharing.shared || sharing.press,
    household: sharing.press && memberPressable,
    memberPressable,
  };
}

/** Only well-formed entities of shown domains; everything else in /api/states is ignored. */
export function shownStates(list: unknown): HaState[] {
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is HaState => {
    if (!s || typeof s !== "object") return false;
    const id = (s as HaState).entity_id;
    return typeof id === "string" && HA_ENTITY_ID.test(id) && SHOWN_DOMAINS.has(domainOf(id));
  });
}

// ------------------------------------------------------------------ people

/** Person pictures Home Assistant serves itself: uploaded (`/api/image/serve/…`) or from its `www` folder (`/local/…`). */
export const PERSON_PICTURE = /^\/(api\/image\/serve\/[a-f0-9]{16,64}\/\d{2,4}x\d{2,4}|local\/[A-Za-z0-9_\-./]{1,200}\.(png|jpe?g|webp|gif))$/;

/**
 * One person. With `showPlaces` off (the default) a named zone becomes plain "away": the zone's name never leaves
 * the server. Coordinates are never read at all.
 */
export function toPerson(s: HaState, image: (path: string) => string | null, showPlaces = false): HomeAssistantPerson {
  const a = s.attributes ?? {};
  const state = String(s.state ?? "");
  const pic = str(a.entity_picture);
  const zone = state !== "home" && state !== "not_home" && !UNAVAILABLE.has(state) && !!state;
  const where: HomeAssistantPerson["where"] = state === "home" ? "home" : zone ? (showPlaces ? "zone" : "away") : state === "not_home" ? "away" : "unknown";
  return {
    id: s.entity_id,
    name: displayName(s),
    where,
    place: where === "zone" ? state : null,
    since: ts(s.last_changed),
    image: pic && PERSON_PICTURE.test(pic) && !pic.includes("..") ? image(pic) : null,
  };
}

/** Home first, then named places, then away, then unknown; by name inside each. */
export function sortPeople(people: HomeAssistantPerson[]): HomeAssistantPerson[] {
  const rank = { home: 0, zone: 1, away: 2, unknown: 3 } as const;
  return people.toSorted((x, y) => rank[x.where] - rank[y.where] || x.name.localeCompare(y.name));
}

// ------------------------------------------------------------------ areas

/**
 * The template Gluon renders to learn rooms (REST has no area endpoint). Every function in it is documented
 * template API (`areas`, `area_name`, `area_entities`); rendering templates needs an administrator's token.
 */
export const AREAS_TEMPLATE =
  '{%- set ns = namespace(out=[]) -%}{%- for a in areas() -%}{%- set ns.out = ns.out + [{"id": a, "name": area_name(a), "entities": area_entities(a)}] -%}{%- endfor -%}{{ ns.out | tojson }}';

export interface AreaMap {
  areas: { id: string; name: string; count: number }[];
  byEntity: Map<string, string>;
}

export function parseAreas(text: string): AreaMap {
  const areas: AreaMap["areas"] = [];
  const byEntity = new Map<string, string>();
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return { areas, byEntity };
  }
  if (!Array.isArray(list)) return { areas, byEntity };
  for (const it of list) {
    const name = str((it as { name?: unknown })?.name);
    const id = str((it as { id?: unknown })?.id);
    if (!name || !id) continue;
    const ents = (it as { entities?: unknown }).entities;
    let count = 0;
    if (Array.isArray(ents)) {
      for (const e of ents) {
        if (typeof e !== "string") continue;
        count++;
        if (!byEntity.has(e)) byEntity.set(e, name);
      }
    }
    areas.push({ id, name, count });
  }
  return { areas: areas.toSorted((x, y) => x.name.localeCompare(y.name)), byEntity };
}

// ------------------------------------------------------------------ who may press what

export type ControlPlan = { ok: true; domain: string; service: string; verb: string } | { ok: false; status: 403 | 400; message: string };

/**
 * Whether this person may do `action` to an entity, and which Home Assistant service does it.
 * Admins may use any control Gluon offers; household members only the ones an admin allowed for the household.
 * Locks, alarms and anything else without a control are refused for everyone.
 */
export function planControl(input: {
  role: "admin" | "member";
  entityId: string;
  action: string;
  /** What an admin let the household press. */
  householdAllowed: readonly string[];
  /** The entity's device class from Home Assistant, when known: garage, gate and door covers are admin-only. */
  deviceClass?: string | null;
}): ControlPlan {
  const { role, entityId } = input;
  if (!HA_ENTITY_ID.test(entityId)) return { ok: false, status: 400, message: "That isn't a Home Assistant entity." };
  if (!(HA_ACTIONS as readonly string[]).includes(input.action)) return { ok: false, status: 400, message: "That doesn't work for this one." };
  const action = input.action as HaAction;
  const domain = domainOf(entityId);
  const control = controlOf(domain);
  if (!control) return { ok: false, status: 400, message: "Gluon only shows this one; change it in Home Assistant." };
  if (role !== "admin" && memberLookOnly(domain, input.deviceClass)) {
    return { ok: false, status: 403, message: "Garage doors, gates and doors open only for whoever runs the server." };
  }
  if (role !== "admin" && !input.householdAllowed.includes(entityId)) {
    return { ok: false, status: 403, message: "Whoever runs the server hasn't let the household use this one." };
  }
  const fits: Record<HaControl, Partial<Record<HaAction, [string, string]>>> = {
    toggle: { turn_on: ["turn_on", "Turned on"], turn_off: ["turn_off", "Turned off"] },
    cover: { open: ["open_cover", "Opened"], close: ["close_cover", "Closed"] },
    run: { run: ["turn_on", domain === "scene" ? "Started the scene" : "Ran"] },
    press: { press: ["press", "Pressed"] },
  };
  const hit = fits[control][action];
  if (!hit) return { ok: false, status: 400, message: "That doesn't work for this one." };
  return { ok: true, domain, service: hit[0], verb: hit[1] };
}

/** An activity entry for a refused press. Only checked values go in: request text that failed validation is never copied. */
export function controlRefusal(input: {
  integrationId: string | null;
  entityId: string;
  action: string;
  name: string | null;
  status: number;
  message: string;
}): { action: string; summary: string; target: string | null; detail: Record<string, unknown>; outcome: "failed" } {
  const validEntity = HA_ENTITY_ID.test(input.entityId);
  const validAction = (HA_ACTIONS as readonly string[]).includes(input.action);
  const what = validEntity ? `“${input.name ?? input.entityId}”` : "something";
  return {
    action: "integration.control",
    summary: input.status === 403 ? `Tried to change ${what} in Home Assistant without permission` : `Gluon refused a change to ${what} in Home Assistant`,
    target: validEntity ? input.entityId : null,
    detail: {
      integration: input.integrationId,
      entity: validEntity ? input.entityId : null,
      action: validAction ? input.action : null,
      refused: input.status === 403 ? "permission" : "invalid",
      reason: input.message,
    },
    outcome: "failed",
  };
}

/**
 * Apply an admin's allow/deny edits to one household list: deny wins, ids stay valid, order is stable.
 * The "see" list takes anything Gluon shows; the "press" list only things members may press (`lookOnly` says which
 * aren't, from their device class).
 */
export function editHousehold(
  list: "see" | "press",
  current: readonly string[],
  allow: readonly string[],
  deny: readonly string[],
  lookOnly: (id: string) => boolean = (id) => memberLookOnly(domainOf(id), null),
  max = 200,
): string[] {
  const denied = new Set(deny);
  const out: string[] = [];
  for (const id of [...current, ...allow]) {
    if (!HA_ENTITY_ID.test(id) || denied.has(id) || out.includes(id) || !SHOWN_DOMAINS.has(domainOf(id))) continue;
    if (list === "press" && lookOnly(id)) continue;
    out.push(id);
  }
  return out.slice(0, max);
}

// ------------------------------------------------------------------ what a viewer gets

/**
 * The picked entities as one viewer may see them. Admins get every picked thing that exists. Members (and an
 * unknown viewer) only get what an admin shared with the household: anything else lands in `notShared`, whether or
 * not it exists, so asking reveals nothing about it.
 */
export function entitiesFor(input: {
  states: HaState[];
  only: readonly string[];
  role: "admin" | "member" | null;
  /** Everything shared with the household to look at (the "see" list and the "press" list together). */
  shared: readonly string[];
  map: (s: HaState) => HomeAssistantEntity;
}): { entities: HomeAssistantEntity[]; missing: string[]; notShared: string[] } {
  const byId = new Map(input.states.map((s) => [s.entity_id, s]));
  const shared = new Set(input.shared);
  const admin = input.role === "admin";
  const entities: HomeAssistantEntity[] = [];
  const missing: string[] = [];
  const notShared: string[] = [];
  for (const id of input.only) {
    if (!admin && !shared.has(id)) {
      notShared.push(id);
      continue;
    }
    const s = byId.get(id);
    if (s) entities.push(input.map(s));
    else missing.push(id);
  }
  return { entities, missing, notShared };
}

// ------------------------------------------------------------------ search

/** Rank things whose name or id contain every word of the query: name starts first, then name contains, then id. */
export function matchStates(states: HaState[], q: string, areaOf: (id: string) => string | null): { s: HaState; score: number }[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: { s: HaState; score: number }[] = [];
  for (const s of states) {
    const name = displayName(s).toLowerCase();
    const hay = `${name} ${s.entity_id} ${(areaOf(s.entity_id) ?? "").toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    const first = terms[0]!;
    const score = name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2;
    out.push({ s, score });
  }
  return out.sort((x, y) => x.score - y.score || displayName(x.s).localeCompare(displayName(y.s)));
}

const DOMAIN_WORD: Record<string, string> = {
  light: "Light",
  switch: "Switch",
  fan: "Fan",
  cover: "Cover",
  climate: "Thermostat",
  lock: "Lock",
  scene: "Scene",
  script: "Script",
  input_boolean: "Switch",
  input_button: "Button",
  button: "Button",
  sensor: "Sensor",
  binary_sensor: "Sensor",
  media_player: "Player",
  vacuum: "Vacuum",
  alarm_control_panel: "Alarm",
  person: "Person",
  input_number: "Number",
  number: "Number",
  water_heater: "Water heater",
  humidifier: "Humidifier",
  valve: "Valve",
  lawn_mower: "Mower",
};

/** "Light · on · Kitchen" */
export function searchHint(e: HomeAssistantEntity): string {
  const reading = e.value !== null ? `${e.value}${e.unit ? (e.unit === "%" ? "%" : ` ${e.unit}`) : ""}` : null;
  const state = [e.words?.toLowerCase(), reading].filter(Boolean).join(" ");
  return [DOMAIN_WORD[e.domain] ?? cap(e.domain), state || null, e.area].filter(Boolean).join(" · ");
}
