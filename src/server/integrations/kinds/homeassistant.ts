import "server-only";
import { z } from "zod";
import { client, obj, ok, runTest, str, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { cached, invalidate } from "../cache";
import { imageUrl } from "../image-refs";
import {
  AREAS_TEMPLATE,
  displayName,
  domainOf,
  entitiesFor,
  matchStates,
  parseAreas,
  PERSON_PICTURE,
  searchHint,
  shownStates,
  sortPeople,
  toEntity,
  toPerson,
  toPickable,
  type AreaMap,
  type HaState,
} from "./homeassistant-map";
import { HA_ENTITY_ID, type HomeAssistantEntitiesData, type HomeAssistantEntity, type HomeAssistantPeopleData, type HomeAssistantPickableList } from "@/lib/widgets-types";

const schema = z.object({
  token: z.string().trim().min(20, "Paste the whole long-lived access token from Home Assistant.").max(1000),
  allowSelfSigned: z.boolean().default(false),
  /**
   * What household members may press (entity ids), and what they may only look at. Admins set both from a Home
   * Assistant widget's settings; they live here, on the connection, so a member can't grant them to themselves by
   * editing their own widget. Pressing implies seeing.
   */
  householdControls: z.array(z.string().regex(HA_ENTITY_ID)).max(200).default([]),
  householdVisible: z.array(z.string().regex(HA_ENTITY_ID)).max(200).default([]),
  /** Who's home names zones ("At Work") only when an admin turns this on. */
  showPlaces: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;
type Ctx = KindContext<Config>;

function http(ctx: Ctx) {
  return client(def, ctx, (status) =>
    status === 401
      ? "Home Assistant didn't accept the token. It may have been deleted: make a new long-lived access token and paste it again."
      : "Home Assistant refused: the token's user isn't allowed to do that.",
  );
}

// One fetch of /api/states serves every widget, the settings picker and search for a few seconds.
const key = (ctx: Ctx, what: string) => `int:${ctx.id ?? ctx.baseUrl}:${ctx.version}:ha:${what}`;

async function allStates(ctx: Ctx): Promise<HaState[]> {
  const r = await cached(key(ctx, "states"), 4000, async () => shownStates(await http(ctx).json<unknown>("/api/states", { maxBytes: 16 * 1024 * 1024, timeoutMs: 6000 })));
  return r.value;
}

async function homeConfig(ctx: Ctx): Promise<{ location: string | null; tempUnit: string | null; version: string | null }> {
  const r = await cached(key(ctx, "config"), 10 * 60_000, async () => {
    const c = obj(await http(ctx).json<unknown>("/api/config"));
    return { location: str(c.location_name), tempUnit: str(obj(c.unit_system).temperature), version: str(c.version) };
  });
  return r.value;
}

/** Rooms, through the template API. Needs an administrator's token; without one there are simply no rooms. */
async function areaMap(ctx: Ctx): Promise<AreaMap & { note: string | null }> {
  const r = await cached(key(ctx, "areas"), 5 * 60_000, async () => {
    const res = await http(ctx).raw("/api/template", { method: "POST", body: { template: AREAS_TEMPLATE }, allow: [400, 401, 403] });
    if (res.status === 401 || res.status === 403) {
      return { areas: [], byEntity: new Map<string, string>(), note: "Rooms need a token from a Home Assistant administrator." };
    }
    if (res.status >= 400) return { areas: [], byEntity: new Map<string, string>(), note: "This Home Assistant didn't say which room things are in." };
    return { ...parseAreas(res.body.toString("utf8")), note: null };
  });
  return r.value;
}

const areaSafe = (ctx: Ctx) => areaMap(ctx).catch(() => ({ areas: [], byEntity: new Map<string, string>(), note: null }));

function mapper(ctx: Ctx, areas: AreaMap, tempUnit: string | null) {
  const see = new Set(ctx.config.householdVisible);
  const press = new Set(ctx.config.householdControls);
  return (s: HaState): HomeAssistantEntity =>
    toEntity(s, { area: areas.byEntity.get(s.entity_id) ?? null, shared: see.has(s.entity_id), press: press.has(s.entity_id), tempUnit });
}

async function entities(ctx: Ctx, params: Record<string, unknown>): Promise<HomeAssistantEntitiesData> {
  const only = Array.isArray(params.only) ? (params.only as string[]) : [];
  const [states, config, areas] = await Promise.all([allStates(ctx), homeConfig(ctx).catch(() => null), only.length ? areaSafe(ctx) : null]);
  const location = config?.location ?? null;
  if (!only.length) return { location, entities: [], missing: [], notShared: [] };
  const map = mapper(ctx, areas ?? { areas: [], byEntity: new Map() }, config?.tempUnit ?? null);
  return { location, ...entitiesFor({ states, only, role: ctx.viewer?.role ?? null, shared: sharedOf(ctx.config), map }) };
}

async function people(ctx: Ctx): Promise<HomeAssistantPeopleData> {
  const states = await allStates(ctx);
  const list = sortPeople(
    states
      .filter((s) => domainOf(s.entity_id) === "person")
      .map((s) => toPerson(s, (path) => imageUrl(ctx.id, `pic:${path}`, { p: path }), ctx.config.showPlaces)),
  );
  return { people: list, home: list.filter((p) => p.where === "home").length, places: ctx.config.showPlaces };
}

/**
 * Everything a Home Assistant widget can show, for its settings (no states, just what and where).
 * `limitTo` narrows it for household members: only those ids, and their rooms, leave the server.
 */
export async function pickable(ctx: KindContext<Record<string, unknown>>, limitTo?: ReadonlySet<string>): Promise<HomeAssistantPickableList> {
  const c = ctx as unknown as Ctx;
  const [states, areas] = await Promise.all([allStates(c), areaSafe(c)]);
  const see = new Set(c.config.householdVisible);
  const press = new Set(c.config.householdControls);
  const list = states
    .filter((s) => domainOf(s.entity_id) !== "person" && (!limitTo || limitTo.has(s.entity_id)))
    .map((s) => toPickable(s, areas.byEntity.get(s.entity_id) ?? null, { shared: see.has(s.entity_id), press: press.has(s.entity_id) }))
    .sort((x, y) => (x.area ?? "\uffff").localeCompare(y.area ?? "\uffff") || x.name.localeCompare(y.name));
  if (limitTo) {
    const rooms = [...new Set(list.map((p) => p.area).filter((a): a is string => !!a))].sort((x, y) => x.localeCompare(y));
    return { entities: list, areas: rooms, areasNote: null };
  }
  return { entities: list, areas: areas.areas.map((a) => a.name), areasNote: areas.note };
}

/** Call a service on one entity, then read it back so the widget can show the result straight away. */
export async function callService(ctx: KindContext<Record<string, unknown>>, plan: { domain: string; service: string }, entityId: string): Promise<HomeAssistantEntity | null> {
  const c = ctx as unknown as Ctx;
  const h = http(c);
  await h.json<unknown>(`/api/services/${plan.domain}/${plan.service}`, { method: "POST", body: { entity_id: entityId }, timeoutMs: 10_000 });
  try {
    const s = await h.json<HaState>(`/api/states/${entityId}`);
    if (!s || typeof s !== "object" || s.entity_id !== entityId) return null;
    const [config, areas] = await Promise.all([homeConfig(c).catch(() => null), areaSafe(c)]);
    return mapper(c, areas, config?.tempUnit ?? null)(s);
  } catch {
    return null;
  }
}

/** The name people know a thing by, from the shared states fetch (for activity entries). */
export async function nameOf(ctx: KindContext<Record<string, unknown>>, entityId: string): Promise<string | null> {
  const s = (await allStates(ctx as unknown as Ctx).catch(() => [] as HaState[])).find((x) => x.entity_id === entityId);
  return s ? displayName(s) : null;
}

/** Drop what a control changed, so the next widget refresh reads Home Assistant again. */
export function forgetStates(ctx: KindContext<Record<string, unknown>>) {
  invalidate(`int:${ctx.id}:${ctx.version}:ha:states`);
  invalidate(`int:${ctx.id}:${ctx.version}:homeassistant.`);
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** What an admin let household members press. */
export const householdControlsOf = (config: Record<string, unknown> | null): string[] => idList(config?.householdControls);
/** What an admin shared with household members only to look at. */
export const householdVisibleOf = (config: Record<string, unknown> | null): string[] => idList(config?.householdVisible);
/** Everything household members may see: the "see" list and the "press" list together. */
export const sharedOf = (config: Record<string, unknown> | null): string[] => [...new Set([...householdVisibleOf(config), ...householdControlsOf(config)])];

/** An entity's device class from the shared states fetch (garage, gate, door…), or null. */
export async function deviceClassOf(ctx: KindContext<Record<string, unknown>>, entityId: string): Promise<string | null> {
  const s = (await allStates(ctx as unknown as Ctx)).find((x) => x.entity_id === entityId);
  return s ? str(s.attributes?.device_class) : null;
}

/** Device classes for many entities at once (for checking an admin's household edits). */
export async function deviceClasses(ctx: KindContext<Record<string, unknown>>): Promise<Map<string, string | null>> {
  return new Map((await allStates(ctx as unknown as Ctx)).map((s) => [s.entity_id, str(s.attributes?.device_class)]));
}

/** A link into Home Assistant itself, only when the address is one a browser could open too. */
function browserBase(ctx: Ctx): string | null {
  try {
    const u = new URL(ctx.baseUrl);
    if (/^(127\.|localhost$|\[::1\]$|host\.docker\.internal$|172\.1[6-9]\.|172\.2\d\.|172\.3[01]\.)/.test(u.hostname)) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function search(ctx: Ctx, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const term = q.trim().toLowerCase();
  if (term.length < 2 || opts.limit < 1) return [];
  // Rooms are a bonus: never let them hold up the answer.
  const [states, areas, config] = await abortable(
    Promise.all([allStates(ctx), Promise.race([areaSafe(ctx), new Promise<null>((r) => setTimeout(() => r(null), 800))]), homeConfig(ctx).catch(() => null)]),
    opts.signal,
  );
  const byEntity = areas?.byEntity ?? new Map<string, string>();
  const base = browserBase(ctx);
  const hits: KindSearchHit[] = [];
  // Only admins search the whole house; anyone else (or an unknown caller) finds only what's shared with the household.
  const admin = ctx.viewer?.role === "admin";
  const shared = new Set(sharedOf(ctx.config));
  const visible = admin ? states : states.filter((s) => shared.has(s.entity_id));
  const sharedRooms = admin ? null : new Set(visible.map((s) => byEntity.get(s.entity_id)).filter(Boolean));
  for (const a of (areas?.areas ?? []).filter((x) => !sharedRooms || sharedRooms.has(x.name))) {
    if (hits.length >= Math.ceil(opts.limit / 3)) break;
    if (a.name.toLowerCase().includes(term)) hits.push({ id: `area:${a.id}`, label: a.name, hint: admin ? `Room · ${a.count} ${a.count === 1 ? "thing" : "things"}` : "Room", type: "area" });
  }
  const map = mapper(ctx, areas ?? { areas: [], byEntity }, config?.tempUnit ?? null);
  for (const { s } of matchStates(visible, term, (id) => byEntity.get(id) ?? null)) {
    if (hits.length >= opts.limit) break;
    const e = map(s);
    hits.push({
      id: e.id,
      label: e.name,
      hint: searchHint(e),
      type: e.icon,
      url: base ? `${base}/history?entity_id=${encodeURIComponent(e.id)}` : undefined,
    });
  }
  return hits.slice(0, opts.limit);
}

export const def: KindDef<Config> = {
  kind: "homeassistant",
  label: "Home Assistant",
  description: "Lights, switches, scenes, sensors and who's home, from Home Assistant.",
  baseUrlLabel: "Home Assistant address",
  baseUrlPlaceholder: "http://127.0.0.1:8123",
  keyHelp:
    "In Home Assistant, open your profile (your name at the bottom of the sidebar) → Security → Long-lived access tokens → Create token. Call it “Gluon” and paste it here. The token can do what its user can: an administrator's token also lets widgets group things by room.",
  fields: [
    { key: "token", label: "Long-lived access token", type: "password", required: true, secret: true },
    {
      key: "showPlaces",
      label: "Show where people are",
      type: "boolean",
      required: false,
      secret: false,
      help: "Who's home names places like “Work”. Off: only Home or Away, and place names never leave the server.",
    },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["token"],
  widgets: ["homeassistant.entities", "homeassistant.people"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    req.headers.Authorization = `Bearer ${ctx.config.token}`;
  },
  test: (ctx) =>
    runTest(async () => {
      const h = http(ctx);
      const hello = obj(await h.json<unknown>("/api/"));
      if (!str(hello.message)) throw new UpstreamError("That address answered, but it doesn't look like Home Assistant's API.");
      const c = obj(await h.json<unknown>("/api/config"));
      const version = str(c.version);
      const location = str(c.location_name);
      const states = shownStates(await h.json<unknown>("/api/states", { maxBytes: 16 * 1024 * 1024, timeoutMs: 8000 }));
      const t = await h.raw("/api/template", { method: "POST", body: { template: AREAS_TEMPLATE }, allow: [400, 401, 403] });
      const rooms = t.status < 300 ? parseAreas(t.body.toString("utf8")).areas.length : null;
      const people = states.filter((s) => domainOf(s.entity_id) === "person").length;
      return ok(`Connected to Home Assistant${version ? ` ${version}` : ""}${location ? ` (“${location}”)` : ""}.`, {
        version,
        serverName: location,
        detail:
          rooms === null
            ? `Gluon can see ${states.length} things. Rooms won't show: the token isn't from a Home Assistant administrator.`
            : `Gluon can see ${states.length} things in ${rooms} ${rooms === 1 ? "room" : "rooms"}${people ? ` and ${people} ${people === 1 ? "person" : "people"}` : ""}.`,
      });
    }),
  data: {
    "homeassistant.entities": (ctx, p) => entities(ctx, p),
    "homeassistant.people": (ctx) => people(ctx),
  },
  image: {
    schema: z.object({ p: z.string().max(260).regex(PERSON_PICTURE).refine((p) => !p.includes("..")) }),
    ref: (p) => `pic:${p.p}`,
    request: (_ctx, p) => ({ path: String(p.p), query: {} }),
  },
  search: (ctx, q, opts) => search(ctx, q, opts),
  viewerScoped: true,
};
