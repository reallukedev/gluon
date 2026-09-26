import "server-only";
import { dayNumber, daysInMonth, fromDayNumber, isoDate, resolveTzid, utcToWall, weekday, zonedToUtc, type Wall, type Zone, UTC } from "./tz";
import type { CalendarEvent } from "@/lib/widgets-types";

/**
 * A small iCalendar (RFC 5545) reader for "what's coming up": VEVENTs with all-day and timed starts, TZIDs
 * (IANA, Windows and fixed-offset VTIMEZONEs), DTEND/DURATION, STATUS:CANCELLED, EXDATE, RDATE, RECURRENCE-ID
 * overrides and RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH).
 */

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** A date or date-time as written, before zone resolution. */
interface IcsTime {
  wall: Wall;
  allDay: boolean;
  /** "utc" for Z times, a zone for TZID, null for floating. */
  zone: Zone | "utc" | null;
}

interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: IcsTime | null;
  byDay: { n: number | null; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
  wkst: number;
}

interface VEvent {
  uid: string;
  summary: string;
  location: string | null;
  start: IcsTime;
  end: IcsTime | null;
  durationMs: number | null;
  rrule: RRule | null;
  rdates: IcsTime[];
  exdates: IcsTime[];
  recurrenceId: IcsTime | null;
  cancelled: boolean;
}

export interface ParsedCalendar {
  name: string | null;
  tz: string | null;
  events: VEvent[];
  fixedZones: Map<string, Zone>;
}

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line) out.push(line);
  }
  return out;
}

function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]+|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

const unescapeText = (s: string) =>
  s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();

function parseTime(value: string, params: Record<string, string>): IcsTime | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const wall: Wall = { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0 };
  if (wall.m < 1 || wall.m > 12 || wall.d < 1 || wall.d > 31) return null;
  if (!m[4] || params.VALUE === "DATE") return { wall: { ...wall, h: 0, mi: 0, s: 0 }, allDay: true, zone: null };
  if (m[7]) return { wall, allDay: false, zone: "utc" };
  if (params.TZID) return { wall, allDay: false, zone: resolveTzid(params.TZID) ?? ({ kind: "iana", name: `__unresolved:${params.TZID}` } as Zone) };
  return { wall, allDay: false, zone: null };
}

/** ISO 8601 duration as used by iCalendar: P1W, P1DT2H30M, -PT15M. */
function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(v: string): RRule | null {
  const kv: Record<string, string> = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (k && val !== undefined) kv[k.toUpperCase()] = val;
  }
  const freq = kv.FREQ as RRule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  // Rules we can't expand faithfully (e.g. BYSETPOS, hourly) are shown as their first occurrence only.
  if (kv.BYSETPOS || kv.BYHOUR || kv.BYMINUTE || kv.BYWEEKNO || kv.BYYEARDAY) return null;
  const byDay: RRule["byDay"] = [];
  for (const d of (kv.BYDAY ?? "").split(",").filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
    if (m) byDay.push({ n: m[1] ? Number(m[1]) : null, wd: WD[m[2]!.toUpperCase()]! });
  }
  const until = kv.UNTIL ? parseTime(kv.UNTIL, {}) : null;
  return {
    freq,
    interval: Math.max(1, Number(kv.INTERVAL ?? 1) || 1),
    count: kv.COUNT ? Math.max(0, Number(kv.COUNT) || 0) : null,
    until,
    byDay,
    byMonthDay: (kv.BYMONTHDAY ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31),
    byMonth: (kv.BYMONTH ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12),
    wkst: WD[(kv.WKST ?? "MO").toUpperCase()] ?? 1,
  };
}

function offsetFrom(v: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * ((+m[2]! * 60 + +m[3]!) * 60 + +(m[4] ?? 0)) * 1000;
}

export function parseIcs(text: string): ParsedCalendar {
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) throw new Error("not a calendar");
  const lines = unfold(text);
  const stack: string[] = [];
  const events: VEvent[] = [];
  const fixedZones = new Map<string, Zone>();
  let name: string | null = null;
  let tz: string | null = null;
  let cur: Prop[] | null = null;
  let tzid: string | null = null;
  let tzStdOffset: number | null = null;

  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT" && stack.length === 2) cur = [];
      if (comp === "VTIMEZONE") {
        tzid = null;
        tzStdOffset = null;
      }
      continue;
    }
    if (p.name === "END") {
      const comp = stack.pop();
      if (comp === "VEVENT" && cur) {
        const ev = buildEvent(cur);
        if (ev) events.push(ev);
        cur = null;
      }
      if (comp === "VTIMEZONE" && tzid && tzStdOffset !== null && !resolveTzid(tzid)) {
        fixedZones.set(tzid, { kind: "fixed", offsetMs: tzStdOffset });
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === "VEVENT" && cur && stack.length === 2) cur.push(p);
    else if (top === "VCALENDAR") {
      if (p.name === "X-WR-CALNAME") name = unescapeText(p.value) || null;
      else if (p.name === "X-WR-TIMEZONE") tz = p.value.trim() || null;
    } else if (top === "VTIMEZONE" && p.name === "TZID") tzid = p.value.trim();
    else if (top === "STANDARD" && p.name === "TZOFFSETTO") tzStdOffset = offsetFrom(p.value);
  }
  return { name, tz, events, fixedZones };
}

function buildEvent(props: Prop[]): VEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const dtstart = get("DTSTART");
  const start = dtstart ? parseTime(dtstart.value, dtstart.params) : null;
  if (!start) return null;
  const dtend = get("DTEND");
  const dur = get("DURATION");
  const times = (n: string) =>
    props
      .filter((p) => p.name === n && p.params.VALUE !== "PERIOD")
      .flatMap((p) => p.value.split(",").map((v) => parseTime(v, p.params)))
      .filter((t): t is IcsTime => !!t);
  const rr = get("RRULE");
  const rid = get("RECURRENCE-ID");
  return {
    uid: get("UID")?.value.trim() || `${dtstart!.value}-${get("SUMMARY")?.value ?? ""}`,
    summary: unescapeText(get("SUMMARY")?.value ?? "") || "Busy",
    location: get("LOCATION") ? unescapeText(get("LOCATION")!.value) || null : null,
    start,
    end: dtend ? parseTime(dtend.value, dtend.params) : null,
    durationMs: dur ? parseDuration(dur.value) : null,
    rrule: rr ? parseRRule(rr.value) : null,
    rdates: times("RDATE"),
    exdates: times("EXDATE"),
    recurrenceId: rid ? parseTime(rid.value, rid.params) : null,
    cancelled: (get("STATUS")?.value.trim().toUpperCase() ?? "") === "CANCELLED",
  };
}

// ------------------------------------------------------------------ expansion

interface Resolver {
  zoneOf(t: IcsTime): Zone;
  viewer: Zone;
}

function instant(t: IcsTime, r: Resolver): number {
  if (t.allDay) return zonedToUtc(t.wall, r.viewer);
  return zonedToUtc(t.wall, r.zoneOf(t));
}

function withDate(t: IcsTime, y: number, m: number, d: number): IcsTime {
  return { ...t, wall: { ...t.wall, y, m, d } };
}

/** Candidate dates (as day numbers) of a rule, in order, starting at the event's first date. */
function* ruleDates(ev: VEvent, rule: RRule, fromDay: number, maxDay: number): Generator<number> {
  const s = ev.start.wall;
  const startDay = dayNumber(s.y, s.m, s.d);
  const fastForward = rule.count === null;
  if (rule.freq === "DAILY") {
    let k = fastForward ? Math.max(0, Math.floor((fromDay - startDay) / rule.interval) - 1) : 0;
    for (; ; k++) {
      const day = startDay + k * rule.interval;
      if (day > maxDay) return;
      const { m } = fromDayNumber(day);
      if (rule.byMonth.length && !rule.byMonth.includes(m)) continue;
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === weekday(day))) continue;
      yield day;
    }
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.wd))] : [weekday(startDay)];
    const weekStart = startDay - ((weekday(startDay) - rule.wkst + 7) % 7);
    const order = days.map((wd) => (wd - rule.wkst + 7) % 7).sort((a, b) => a - b);
    let k = fastForward ? Math.max(0, Math.floor((fromDay - weekStart) / (7 * rule.interval)) - 1) : 0;
    for (; ; k++) {
      const ws = weekStart + k * 7 * rule.interval;
      if (ws > maxDay) return;
      for (const o of order) {
        const day = ws + o;
        if (day < startDay) continue;
        if (rule.byMonth.length && !rule.byMonth.includes(fromDayNumber(day).m)) continue;
        yield day;
      }
    }
  }
  if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    const stepMonths = rule.freq === "MONTHLY" ? rule.interval : 12 * rule.interval;
    const from = fromDayNumber(fromDay);
    const monthsBetween = (from.y - s.y) * 12 + (from.m - s.m);
    let k = fastForward ? Math.max(0, Math.floor(monthsBetween / stepMonths) - 1) : 0;
    for (; ; k++) {
      const total = s.m - 1 + k * stepMonths;
      const y = s.y + Math.floor(total / 12);
      if (dayNumber(y, 1, 1) > maxDay) return;
      // YEARLY with BYMONTH expands to each listed month of that year.
      const months = rule.freq === "YEARLY" ? (rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [s.m]) : [(total % 12) + 1];
      for (const m of months) {
        if (rule.freq === "MONTHLY" && rule.byMonth.length && !rule.byMonth.includes(m)) continue;
        const dim = daysInMonth(y, m);
        const found: number[] = [];
        if (rule.byMonthDay.length) {
          for (const md of rule.byMonthDay) {
            const d = md > 0 ? md : dim + md + 1;
            if (d >= 1 && d <= dim) found.push(d);
          }
        } else if (rule.byDay.length) {
          for (const b of rule.byDay) {
            const matches: number[] = [];
            for (let d = 1; d <= dim; d++) if (weekday(dayNumber(y, m, d)) === b.wd) matches.push(d);
            if (b.n === null) found.push(...matches);
            else {
              const d = b.n > 0 ? matches[b.n - 1] : matches[matches.length + b.n];
              if (d) found.push(d);
            }
          }
        } else if (s.d <= dim) {
          found.push(s.d); // Feb 29 / 31st: skip months without that day (RFC behaviour)
        }
        for (const d of [...new Set(found)].sort((a, b) => a - b)) {
          const day = dayNumber(y, m, d);
          if (day >= startDay) yield day;
        }
      }
    }
  }
}

interface Occurrence {
  ev: VEvent;
  start: IcsTime;
  recurring: boolean;
}

function expand(ev: VEvent, r: Resolver, windowStart: number, windowEnd: number, durationMs: number): Occurrence[] {
  const out: Occurrence[] = [];
  const exKeys = new Set<string>();
  for (const x of ev.exdates) {
    exKeys.add(isoDate(x.wall.y, x.wall.m, x.wall.d) + (x.allDay ? "" : `@${instant(x, r)}`));
    exKeys.add(isoDate(x.wall.y, x.wall.m, x.wall.d));
  }
  const excluded = (t: IcsTime) => {
    if (t.allDay) return exKeys.has(isoDate(t.wall.y, t.wall.m, t.wall.d));
    return exKeys.has(`${isoDate(t.wall.y, t.wall.m, t.wall.d)}@${instant(t, r)}`) || ev.exdates.some((x) => x.allDay && x.wall.y === t.wall.y && x.wall.m === t.wall.m && x.wall.d === t.wall.d);
  };

  if (!ev.rrule) {
    out.push({ ev, start: ev.start, recurring: false });
  } else {
    const rule = ev.rrule;
    const untilMs = rule.until
      ? rule.until.allDay
        ? zonedToUtc({ ...rule.until.wall, h: 23, mi: 59, s: 59 }, ev.start.allDay ? r.viewer : r.zoneOf(ev.start))
        : instant(rule.until, r)
      : null;
    const winStartWall = utcToWall(windowStart - durationMs - 86_400_000, r.zoneOf(ev.start));
    const fromDay = dayNumber(winStartWall.y, winStartWall.m, winStartWall.d);
    let n = 0;
    let guard = 0;
    const endWall = utcToWall(windowEnd, r.zoneOf(ev.start));
    const maxDay = dayNumber(endWall.y, endWall.m, endWall.d) + 1;
    for (const day of ruleDates(ev, rule, fromDay, maxDay)) {
      if (++guard > 20_000) break;
      const { y, m, d } = fromDayNumber(day);
      const occ = withDate(ev.start, y, m, d);
      const at = instant(occ, r);
      if (untilMs !== null && at > untilMs) break;
      n++;
      if (rule.count !== null && n > rule.count) break;
      if (at > windowEnd) break;
      out.push({ ev, start: occ, recurring: true });
    }
  }
  for (const rd of ev.rdates) out.push({ ev, start: rd.allDay === ev.start.allDay ? rd : withDate(ev.start, rd.wall.y, rd.wall.m, rd.wall.d), recurring: true });
  return out.filter((o) => !excluded(o.start));
}

export interface UpcomingOptions {
  now: number;
  days: number;
  limit: number;
  viewer: Zone;
}

export function upcoming(cal: ParsedCalendar, opts: UpcomingOptions): CalendarEvent[] {
  const calZone = resolveTzid(cal.tz) ?? opts.viewer;
  const r: Resolver = {
    viewer: opts.viewer,
    zoneOf(t) {
      if (t.zone === "utc") return UTC;
      if (t.zone === null) return calZone;
      if (t.zone.kind === "iana" && t.zone.name.startsWith("__unresolved:")) {
        const id = t.zone.name.slice("__unresolved:".length);
        return cal.fixedZones.get(id) ?? calZone;
      }
      return t.zone;
    },
  };
  const windowStart = opts.now;
  const nowWall = utcToWall(opts.now, opts.viewer);
  const todayStart = zonedToUtc({ ...nowWall, h: 0, mi: 0, s: 0 }, opts.viewer);
  const windowEnd = todayStart + opts.days * 86_400_000;

  // Overrides (RECURRENCE-ID) replace the matching occurrence of their series.
  const overrides = new Map<string, VEvent[]>();
  for (const ev of cal.events) if (ev.recurrenceId) overrides.set(ev.uid, [...(overrides.get(ev.uid) ?? []), ev]);
  const overrideKey = (t: IcsTime) => (t.allDay ? isoDate(t.wall.y, t.wall.m, t.wall.d) : String(instant(t, r)));

  const out: CalendarEvent[] = [];
  // A hostile calendar (thousands of long-running series) must not hold the server's single thread:
  // stop after 5,000 events or 1.5 s of work and show what was found so far.
  const budgetEnd = Date.now() + 1500;
  let scanned = 0;
  for (const ev of cal.events) {
    if (++scanned > 5000 || Date.now() > budgetEnd) break;
    const allDay = ev.start.allDay;
    let durationMs: number;
    if (ev.end) durationMs = allDay ? (dayNumber(ev.end.wall.y, ev.end.wall.m, ev.end.wall.d) - dayNumber(ev.start.wall.y, ev.start.wall.m, ev.start.wall.d)) * 86_400_000 : instant(ev.end, r) - instant(ev.start, r);
    else if (ev.durationMs !== null) durationMs = ev.durationMs;
    else durationMs = allDay ? 86_400_000 : 0;
    if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = allDay ? 86_400_000 : 0;
    if (allDay && durationMs < 86_400_000) durationMs = 86_400_000;

    const replaced = ev.recurrenceId ? null : new Set((overrides.get(ev.uid) ?? []).map((o) => overrideKey(o.recurrenceId!)));
    for (const occ of expand(ev, r, windowStart, windowEnd, durationMs)) {
      if (ev.cancelled) continue;
      if (replaced?.has(overrideKey(occ.start))) continue;
      let start: number;
      let end: number;
      let startDate: string | null = null;
      let endDate: string | null = null;
      if (allDay) {
        const w = occ.start.wall;
        const firstDay = dayNumber(w.y, w.m, w.d);
        const days = Math.round(durationMs / 86_400_000);
        const last = fromDayNumber(firstDay + days - 1);
        startDate = isoDate(w.y, w.m, w.d);
        endDate = isoDate(last.y, last.m, last.d);
        start = zonedToUtc({ y: w.y, m: w.m, d: w.d, h: 0, mi: 0, s: 0 }, opts.viewer);
        const after = fromDayNumber(firstDay + days);
        end = zonedToUtc({ y: after.y, m: after.m, d: after.d, h: 0, mi: 0, s: 0 }, opts.viewer);
      } else {
        start = instant(occ.start, r);
        end = start + durationMs;
      }
      if (end <= windowStart && !(end === start && start >= windowStart)) continue;
      if (start >= windowEnd) continue;
      out.push({
        id: `${ev.uid}@${startDate ?? start}`,
        title: ev.summary,
        start,
        end: durationMs > 0 || allDay ? end : null,
        allDay,
        startDate,
        endDate,
        location: ev.location,
        recurring: occ.recurring || !!ev.recurrenceId,
        ongoing: start <= opts.now && opts.now < end,
      });
    }
  }
  out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
  // Identical copies (same UID + start) can appear when feeds merge calendars.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).slice(0, opts.limit);
}
