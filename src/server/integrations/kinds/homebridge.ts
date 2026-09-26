import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, UpstreamError, type KindContext, type KindDef } from "./base";
import type { AccessoryKind, HomebridgeAccessoriesData, HomebridgeAccessory } from "@/lib/widgets-types";

const schema = z.object({
  username: z.string().trim().max(100).default(""),
  password: z.string().max(200).default(""),
  allowSelfSigned: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;

/**
 * Homebridge UI (homebridge-config-ui-x) issues JWTs from /api/auth/login. Tokens are kept in memory per
 * integration version and renewed a minute before they expire, or after a 401.
 */
type G = typeof globalThis & { __gluonHbTokens?: Map<string, { token: string; exp: number }> };
const g = globalThis as G;
const tokens = (g.__gluonHbTokens ??= new Map());
const tokenKey = (ctx: KindContext<Config>) => `${ctx.id ?? ctx.baseUrl}:${ctx.version}:${ctx.config.username}`;

function raw(ctx: KindContext<Config>) {
  return client(def, ctx, (status, body) => {
    if (/otp|2fa|two.?factor/i.test(body)) return "This Homebridge account uses two-factor sign-in, which Gluon can't answer. Make a separate Homebridge user for Gluon without it.";
    return status === 401 || status === 403 ? "Homebridge didn't accept that username and password." : null;
  });
}

async function login(ctx: KindContext<Config>): Promise<string> {
  const h = raw(ctx);
  const settings = obj(await h.json("/api/auth/settings", { noAuth: true }).catch(() => ({})));
  let res: Record<string, unknown>;
  if (settings.formAuth === false) {
    res = obj(await h.json("/api/auth/noauth", { method: "POST", body: {}, noAuth: true }));
  } else {
    if (!ctx.config.username || !ctx.config.password) throw new UpstreamError("Homebridge needs a username and password.", null, "upstream_auth");
    const r = await h.raw("/api/auth/login", {
      method: "POST",
      body: { username: ctx.config.username, password: ctx.config.password },
      noAuth: true,
      allow: [400, 401, 403, 412],
    });
    const text = r.body.toString("utf8");
    if (r.status >= 400) {
      if (/otp|2fa|two.?factor/i.test(text)) {
        throw new UpstreamError("This Homebridge account uses two-factor sign-in, which Gluon can't answer. Make a separate Homebridge user for Gluon without it.", r.status, "upstream_auth");
      }
      throw new UpstreamError("Homebridge didn't accept that username and password.", r.status, "upstream_auth");
    }
    try {
      res = obj(JSON.parse(text));
    } catch {
      throw new UpstreamError("Homebridge answered the sign-in with something Gluon couldn't read.");
    }
  }
  const token = str(res.access_token);
  if (!token) throw new UpstreamError("Homebridge didn't hand out a sign-in token.");
  const ttl = (num(res.expires_in) ?? 3600) * 1000;
  tokens.set(tokenKey(ctx), { token, exp: Date.now() + Math.max(60_000, ttl - 60_000) });
  return token;
}

async function hb<T>(ctx: KindContext<Config>, path: string): Promise<T> {
  try {
    return await raw(ctx).json<T>(path);
  } catch (e) {
    if (e instanceof UpstreamError && e.upstreamStatus === 401) {
      tokens.delete(tokenKey(ctx));
      return raw(ctx).json<T>(path);
    }
    throw e;
  }
}

const KIND: Record<string, AccessoryKind> = {
  Lightbulb: "light",
  Switch: "switch",
  StatelessProgrammableSwitch: "switch",
  Outlet: "outlet",
  Fan: "fan",
  Fanv2: "fan",
  Thermostat: "thermostat",
  HeaterCooler: "thermostat",
  TemperatureSensor: "temperature",
  HumiditySensor: "humidity",
  ContactSensor: "contact",
  MotionSensor: "motion",
  OccupancySensor: "motion",
  LockMechanism: "lock",
  WindowCovering: "cover",
  Window: "cover",
  Door: "cover",
  GarageDoorOpener: "cover",
  Television: "tv",
  AirPurifier: "air",
  AirQualitySensor: "air",
};
const SKIP = new Set([
  "AccessoryInformation",
  "ProtocolInformation",
  "Battery",
  "BatteryService",
  "InputSource",
  "TelevisionSpeaker",
  "CameraRTPStreamManagement",
  "CameraOperatingMode",
  "DataStreamTransportManagement",
  "Microphone",
  "Speaker",
  "Doorbell",
  "Label",
  "ServiceLabel",
]);

const bool = (v: unknown): boolean | null => (v === undefined || v === null ? null : v === true || v === 1 || v === "1");

function normalise(services: Record<string, unknown>[], layout: Map<string, { room: string; name: string | null; hidden: boolean }>): HomebridgeAccessory[] {
  // Battery services live next to the sensor they belong to (same bridge + aid).
  const lowBattery = new Map<string, boolean>();
  for (const s of services) {
    const v = obj(s.values);
    if (v.StatusLowBattery !== undefined) lowBattery.set(`${obj(s.instance).username}:${s.aid}`, v.StatusLowBattery === 1 || v.StatusLowBattery === true);
  }
  const out: HomebridgeAccessory[] = [];
  for (const s of services) {
    const type = str(s.humanType) ?? str(s.type) ?? "Unknown";
    if (SKIP.has(type) || s.hidden === true) continue;
    const v = obj(s.values);
    const kind = KIND[type] ?? (v.On !== undefined ? "switch" : "other");
    if (kind === "other") continue;
    const id = String(s.uniqueId ?? `${s.aid}.${s.iid}`);
    const lay = layout.get(id);
    if (lay?.hidden) continue;
    const contact = num(v.ContactSensorState);
    const lock = num(v.LockCurrentState);
    const doorState = num(v.CurrentDoorState);
    out.push({
      id,
      name: lay?.name ?? str(s.serviceName) ?? str(obj(s.accessoryInformation).Name) ?? type,
      room: lay?.room ?? null,
      kind,
      type,
      on: v.On !== undefined ? bool(v.On) : v.Active !== undefined ? bool(v.Active) : null,
      brightness: num(v.Brightness),
      temperature: num(v.CurrentTemperature),
      targetTemperature: num(v.TargetTemperature) ?? num(v.HeatingThresholdTemperature),
      humidity: num(v.CurrentRelativeHumidity),
      contact: contact === null ? null : contact === 0 ? "closed" : "open",
      motion: v.MotionDetected !== undefined ? bool(v.MotionDetected) : v.OccupancyDetected !== undefined ? bool(v.OccupancyDetected) : null,
      locked: lock === null ? null : lock === 1 ? true : lock === 0 ? false : null,
      position: num(v.CurrentPosition) ?? (doorState === null ? null : doorState === 1 ? 0 : doorState === 0 ? 100 : null),
      batteryLow: v.StatusLowBattery !== undefined ? bool(v.StatusLowBattery) : (lowBattery.get(`${obj(s.instance).username}:${s.aid}`) ?? null),
    });
  }
  return out;
}

async function layoutMap(ctx: KindContext<Config>) {
  const map = new Map<string, { room: string; name: string | null; hidden: boolean }>();
  const rooms: string[] = [];
  try {
    for (const room of arr<Record<string, unknown>>(await hb(ctx, "/api/accessories/layout"))) {
      const name = str(room.name) ?? "Default Room";
      rooms.push(name);
      for (const s of arr<Record<string, unknown>>(room.services)) {
        if (s.uniqueId) map.set(String(s.uniqueId), { room: name, name: str(s.customName), hidden: s.hidden === true });
      }
    }
  } catch {
    /* layout is optional */
  }
  return { map, rooms };
}

async function accessories(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<HomebridgeAccessoriesData> {
  const [list, layout, settings] = await Promise.all([
    hb<unknown>(ctx, "/api/accessories"),
    layoutMap(ctx),
    raw(ctx).json("/api/auth/settings", { noAuth: true }).catch(() => ({})),
  ]);
  let items = normalise(arr<Record<string, unknown>>(list), layout.map);
  const only = Array.isArray(params.only) ? (params.only as string[]) : [];
  if (only.length) {
    const byId = new Map(items.map((a) => [a.id, a]));
    items = only.map((id) => byId.get(id)).filter((a): a is HomebridgeAccessory => !!a);
  } else {
    const order = new Map(layout.rooms.map((r, i) => [r, i]));
    items.sort((a, b) => (order.get(a.room ?? "") ?? 999) - (order.get(b.room ?? "") ?? 999) || a.name.localeCompare(b.name));
  }
  const rooms = [...new Set(items.map((a) => a.room).filter((r): r is string => !!r))];
  return { instance: str(obj(obj(settings).env).homebridgeInstanceName), accessories: items, rooms };
}

export const def: KindDef<Config> = {
  kind: "homebridge",
  label: "Homebridge",
  description: "Lights, switches, plugs and sensors from Homebridge (read-only).",
  baseUrlLabel: "Homebridge UI address",
  baseUrlPlaceholder: "http://127.0.0.1:8581",
  keyHelp:
    "Homebridge has no API keys: Gluon signs in like the web UI. In Homebridge, open the menu → User Accounts → Add User, create “gluon” (not an administrator) without two-factor sign-in, and enter it here. Accessory states only appear when Homebridge runs in insecure mode (Settings → Homebridge Settings → “Insecure Mode”, the -I flag), which the Accessories page needs too.",
  fields: [
    { key: "username", label: "Username", type: "text", required: true, secret: false },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["password"],
  widgets: ["homebridge.accessories"],
  insecureTls: (c) => c.allowSelfSigned,
  async authorize(ctx, req) {
    const t = tokens.get(tokenKey(ctx));
    const token = t && t.exp > Date.now() ? t.token : await login(ctx);
    req.headers.Authorization = `Bearer ${token}`;
  },
  test: (ctx) =>
    runTest(async () => {
      const settings = obj(await raw(ctx).json("/api/auth/settings", { noAuth: true }));
      const env = obj(settings.env);
      if (!env.packageName && !env.homebridgeVersion) throw new UpstreamError("That address answered, but it doesn't look like the Homebridge UI.");
      tokens.delete(tokenKey(ctx));
      await login(ctx);
      const version = str(env.homebridgeVersion);
      const name = str(env.homebridgeInstanceName);
      let detail: string | null = null;
      try {
        const list = arr(await hb(ctx, "/api/accessories"));
        if (!list.length) detail = "Homebridge listed no accessories. If you have some, turn on Insecure Mode in Homebridge Settings and restart Homebridge.";
      } catch (e) {
        detail =
          e instanceof UpstreamError && (e.upstreamStatus === 400 || e.upstreamStatus === 500)
            ? "Signed in, but Homebridge won't share accessory states. Turn on Insecure Mode in Homebridge Settings and restart Homebridge."
            : e instanceof UpstreamError
              ? `Signed in, but listing accessories failed: ${e.message}`
              : null;
      }
      return ok(`Connected to Homebridge${version ? ` ${version}` : ""}${name ? ` (“${name}”)` : ""} as “${ctx.config.username || "no-auth"}”.`, {
        version,
        serverName: name,
        detail,
      });
    }),
  data: {
    "homebridge.accessories": (ctx, p) => accessories(ctx, p),
  },
};
