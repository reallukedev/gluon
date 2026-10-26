import "server-only";
import { AppError } from "../errors";
import { decodeText, describeNetError, NetError, openStream, safeFetch, type NetPolicy } from "../integrations/net";
import { parseIcs, upcoming } from "./ics";
import { parseFeed } from "./feed";
import { isIanaZone, resolveTzid, UTC, zoneName, type Zone } from "./tz";
import type { CalendarData, FeedData, GeocodeResult, LinkStatusData, WeatherData, WeatherIcon } from "@/lib/widgets-types";

/** Personal widget sources: public services and URLs people put in their own widgets. */

class SourceError extends AppError {
  constructor(message: string, code = "source_failed") {
    super(code, message, 502);
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function get(url: string, what: string, policy: NetPolicy, opts: { maxBytes?: number; accept?: string } = {}) {
  try {
    const r = await safeFetch(url, {
      policy,
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      headers: opts.accept ? { Accept: opts.accept } : undefined,
    });
    if (r.status === 401 || r.status === 403) throw new SourceError(`${what} answered ${r.status}: the address needs a login or a private link.`);
    if (r.status === 404 || r.status === 410) throw new SourceError(`${what} answered ${r.status}: nothing is at that address any more.`);
    if (r.status >= 400) throw new SourceError(`${what} answered ${r.status}.`);
    return r;
  } catch (e) {
    if (e instanceof NetError) throw new SourceError(describeNetError(e, what, hostOf(url)), e.code === "timeout" ? "timeout" : "source_failed");
    throw e;
  }
}

// ------------------------------------------------------------------ weather (Open-Meteo)

const WMO: Record<number, [string, WeatherIcon]> = {
  0: ["Clear", "clear"],
  1: ["Mostly clear", "clear"],
  2: ["Partly cloudy", "partly-cloudy"],
  3: ["Overcast", "cloudy"],
  45: ["Fog", "fog"],
  48: ["Freezing fog", "fog"],
  51: ["Light drizzle", "drizzle"],
  53: ["Drizzle", "drizzle"],
  55: ["Heavy drizzle", "drizzle"],
  56: ["Freezing drizzle", "freezing-rain"],
  57: ["Heavy freezing drizzle", "freezing-rain"],
  61: ["Light rain", "rain"],
  63: ["Rain", "rain"],
  65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "freezing-rain"],
  67: ["Heavy freezing rain", "freezing-rain"],
  71: ["Light snow", "snow"],
  73: ["Snow", "snow"],
  75: ["Heavy snow", "snow"],
  77: ["Snow grains", "snow"],
  80: ["Light showers", "showers"],
  81: ["Showers", "showers"],
  82: ["Heavy showers", "showers"],
  85: ["Snow showers", "snow-showers"],
  86: ["Heavy snow showers", "snow-showers"],
  95: ["Thunderstorm", "thunder"],
  96: ["Thunderstorm with hail", "thunder"],
  99: ["Thunderstorm with heavy hail", "thunder"],
};
const wmo = (code: number): { condition: string; icon: WeatherIcon } => {
  const [condition, icon] = WMO[code] ?? ["Unknown", "cloudy"];
  return { condition, icon };
};

type Series = Record<string, (number | null)[]>;
const at = (s: Series | undefined, k: string, i: number): number | null => {
  const v = s?.[k]?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export async function weather(cfg: { lat: number; lon: number; name: string | null; hours: number }): Promise<WeatherData> {
  const q = new URLSearchParams({
    latitude: cfg.lat.toFixed(4),
    longitude: cfg.lon.toFixed(4),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,precipitation",
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "3",
    timeformat: "unixtime",
  });
  const r = await get(`https://api.open-meteo.com/v1/forecast?${q}`, "The weather service", "trusted");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new SourceError("The weather service sent something Gluon couldn't read.");
  }
  if (j.error) throw new SourceError(`The weather service said: ${String(j.reason ?? "error")}.`);
  const cur = (j.current ?? {}) as Record<string, number>;
  const hourly = j.hourly as Series | undefined;
  const daily = j.daily as Series | undefined;
  const code = Number(cur.weather_code ?? 0);
  const now = Date.now();
  const hours: WeatherData["hours"] = [];
  const times = hourly?.time ?? [];
  for (let i = 0; i < times.length && hours.length < cfg.hours; i++) {
    const t = (times[i] ?? 0) * 1000;
    if (t + 3600_000 <= now) continue;
    const hc = at(hourly, "weather_code", i) ?? 0;
    hours.push({
      at: t,
      temperature: at(hourly, "temperature_2m", i) ?? 0,
      code: hc,
      icon: wmo(hc).icon,
      precipitationChance: at(hourly, "precipitation_probability", i),
      isDay: at(hourly, "is_day", i) === 1,
    });
  }
  const day = (i: number) => {
    const c = at(daily, "weather_code", i);
    const hi = at(daily, "temperature_2m_max", i);
    const lo = at(daily, "temperature_2m_min", i);
    if (c === null || hi === null || lo === null) return null;
    return { high: hi, low: lo, code: c, ...wmo(c), precipitationChance: at(daily, "precipitation_probability_max", i) };
  };
  const today = day(0);
  if (typeof cur.temperature_2m !== "number" || !today) throw new SourceError("The weather service had no forecast for that place.");
  const sun = (k: string) => {
    const v = at(daily, k, 0);
    return v === null ? null : v * 1000;
  };
  return {
    place: cfg.name,
    timezone: typeof j.timezone === "string" ? j.timezone : "UTC",
    current: {
      at: (cur.time ?? now / 1000) * 1000,
      temperature: cur.temperature_2m,
      feelsLike: cur.apparent_temperature ?? null,
      humidity: cur.relative_humidity_2m ?? null,
      windKph: cur.wind_speed_10m ?? null,
      precipitationMm: cur.precipitation ?? null,
      code,
      ...wmo(code),
      isDay: cur.is_day === 1,
    },
    today: { ...today, sunrise: sun("sunrise"), sunset: sun("sunset") },
    tomorrow: day(1),
    hours,
  };
}

export async function geocode(q: string): Promise<GeocodeResult> {
  const params = new URLSearchParams({ name: q, count: "8", language: "en", format: "json" });
  const r = await get(`https://geocoding-api.open-meteo.com/v1/search?${params}`, "The place search", "trusted");
  let j: { results?: Record<string, unknown>[] };
  try {
    j = JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new SourceError("The place search sent something Gluon couldn't read.");
  }
  return {
    results: (j.results ?? [])
      .filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number")
      .map((p) => {
        const s = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : null);
        return {
          id: Number(p.id ?? 0),
          name: s("name") ?? "Unnamed place",
          region: s("admin1"),
          country: s("country"),
          countryCode: s("country_code"),
          lat: p.latitude as number,
          lon: p.longitude as number,
          timezone: s("timezone"),
        };
      }),
  };
}

// ------------------------------------------------------------------ calendar (ICS)

export async function calendar(cfg: { url: string; days: number; limit: number; tz?: string }, policy: NetPolicy): Promise<CalendarData> {
  const r = await get(cfg.url, "The calendar", policy, { maxBytes: 4 * 1024 * 1024, accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" });
  const text = decodeText(r.body, String(r.headers["content-type"] ?? ""));
  let cal;
  try {
    cal = parseIcs(text);
  } catch {
    throw new SourceError(
      /<html/i.test(text.slice(0, 500))
        ? "That address is a web page, not a calendar. Use the calendar's “secret address in iCal format” (it ends in .ics)."
        : "That address didn't return a calendar (ICS).",
    );
  }
  const viewer: Zone = cfg.tz && isIanaZone(cfg.tz) ? { kind: "iana", name: cfg.tz } : (resolveTzid(cal.tz) ?? UTC);
  return {
    name: cal.name,
    events: upcoming(cal, { now: Date.now(), days: cfg.days, limit: cfg.limit, viewer }),
    timezone: zoneName(viewer),
  };
}

// ------------------------------------------------------------------ feed

export async function feed(cfg: { url: string; limit: number }, policy: NetPolicy): Promise<FeedData> {
  const r = await get(cfg.url, "The feed", policy, {
    maxBytes: 5 * 1024 * 1024,
    accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
  });
  const text = decodeText(r.body, String(r.headers["content-type"] ?? ""));
  try {
    return parseFeed(text, r.url, cfg.limit);
  } catch (e) {
    throw new SourceError(
      e instanceof Error && e.message === "html"
        ? "That address is a web page, not a feed. Look for an RSS or Atom link on the site (often /feed or /rss)."
        : "That address didn't return an RSS, Atom or JSON feed.",
    );
  }
}

// ------------------------------------------------------------------ link status

export async function linkStatus(url: string, policy: NetPolicy): Promise<LinkStatusData> {
  const checkedAt = Date.now();
  const attempt = async (method: "HEAD" | "GET", insecureTls: boolean) => {
    const r = await openStream(url, { method, policy, insecureTls, maxBytes: 64 * 1024, timeoutMs: 5000, totalMs: 6000 });
    r.stream.destroy();
    return r;
  };
  const describe = (status: number, ms: number, note = ""): LinkStatusData => {
    const up = status < 500;
    const what =
      status >= 500 ? `Answering with an error (${status})` : status === 401 || status === 403 ? `Responding (asks for a login)` : status === 404 ? `Responding, but that page wasn't found (404)` : `Responding (${status})`;
    return { url, up, status, latencyMs: ms, message: `${what} in ${ms} ms${note}`, checkedAt };
  };
  try {
    let r = await attempt("HEAD", false);
    if (r.status === 405 || r.status === 501) r = await attempt("GET", false);
    return describe(r.status, r.ms);
  } catch (e) {
    const err = e instanceof NetError ? e : null;
    if (err?.code === "tls") {
      try {
        const r = await attempt("GET", true);
        return describe(r.status, r.ms, "; its certificate isn't trusted");
      } catch {
        /* fall through */
      }
    }
    if (e instanceof AppError) throw e; // bad or blocked address: a config problem, not "down"
    const message = err
      ? {
          timeout: "Didn't answer within 5 seconds",
          refused: "Refused the connection",
          notfound: "That name doesn't resolve",
          unreachable: "Can't be reached from the server",
          reset: "Closed the connection",
          tls: "Its certificate isn't valid",
          blocked: "Gluon won't check that address",
          too_large: "Responding",
          redirects: "Redirects too many times",
          other: "Couldn't connect",
        }[err.code]
      : "Couldn't connect";
    return { url, up: false, status: null, latencyMs: null, message, checkedAt };
  }
}
