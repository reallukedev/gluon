import { describe, expect, it } from "vitest";
import { parseIcs, upcoming, type UpcomingOptions } from "./ics";
import type { Zone } from "./tz";

const UTCZ: Zone = { kind: "iana", name: "UTC" };
const T = (s: string) => Date.parse(s);

const cal = (body: string, eol = "\r\n") =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Test//EN", ...body.trim().split("\n"), "END:VCALENDAR"]
    .map((l) => l.replace(/\r$/, ""))
    .join(eol);

const ev = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\n");

const list = (text: string, opts: Partial<UpcomingOptions> = {}) =>
  upcoming(parseIcs(text), {
    now: T("2026-11-09T12:00:00Z"),
    days: 14,
    limit: 50,
    viewer: UTCZ,
    ...opts,
  });

const starts = (text: string, opts: Partial<UpcomingOptions> = {}) =>
  list(text, opts).map((e) => new Date(e.start).toISOString());

const SAMPLE = `
X-WR-CALNAME:Family
BEGIN:VEVENT
UID:standup@example.com
SUMMARY:Standup
DTSTART:20261101T090000Z
DURATION:PT15M
RRULE:FREQ=DAILY;UNTIL=20261113T235959Z
EXDATE:20261111T090000Z
END:VEVENT
BEGIN:VEVENT
UID:standup@example.com
RECURRENCE-ID:20261112T090000Z
SUMMARY:Standup moved
DTSTART:20261112T150000Z
DURATION:PT15M
END:VEVENT`;

describe("parseIcs", () => {
  it.each([
    ["plain text", "hello"],
    ["an HTML error page", "<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>"],
    ["a calendar buried after 5000 characters", `${"x".repeat(5000)}\nBEGIN:VCALENDAR\nEND:VCALENDAR`],
  ])("rejects %s", (_, text) => {
    expect(() => parseIcs(text)).toThrow(Error);
  });

  it("accepts lower-case markers, unfolds lines and unescapes the calendar name", () => {
    const text = [
      "begin:vcalendar",
      "x-wr-calname:Smith\\, Jane\\; work",
      "X-WR-TIMEZONE:Europe/Berlin",
      "BEGIN:VEVENT",
      "UID:fold@example.com",
      "DTSTART:20261110T090000Z",
      "SUMMARY:Long sum",
      " mary",
      "LOCATION:Room",
      "\t 4",
      "END:VEVENT",
      "end:vcalendar",
    ].join("\r\n");
    const parsed = parseIcs(text);
    expect(parsed.name).toBe("Smith, Jane; work");
    expect(parsed.tz).toBe("Europe/Berlin");
    expect(parsed.events).toHaveLength(1);
    const [e] = upcoming(parsed, {
      now: T("2026-11-09T12:00:00Z"),
      days: 7,
      limit: 10,
      viewer: UTCZ,
    });
    expect(e.title).toBe("Long summary");
    expect(e.location).toBe("Room 4");
  });

  it("leaves name and tz null when absent and ignores malformed lines", () => {
    const parsed = parseIcs(
      cal(`this line has no colon\n${ev("UID:a@example.com", "garbage", "DTSTART:20261110T090000Z")}`),
    );
    expect(parsed.name).toBeNull();
    expect(parsed.tz).toBeNull();
    expect(parsed.events).toHaveLength(1);
  });

  it("records an unknown VTIMEZONE with a STANDARD offset as a fixed zone", () => {
    const parsed = parseIcs(
      cal(`BEGIN:VTIMEZONE
TZID:My Odd Zone
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0530
TZOFFSETTO:+0530
END:STANDARD
END:VTIMEZONE
${ev("UID:odd@example.com", "DTSTART;TZID=My Odd Zone:20261110T090000", "SUMMARY:Odd")}`),
    );
    expect(parsed.fixedZones.get("My Odd Zone")).toEqual({
      kind: "fixed",
      offsetMs: 19_800_000,
    });
    expect(
      new Date(
        upcoming(parsed, {
          now: T("2026-11-09T12:00:00Z"),
          days: 7,
          limit: 5,
          viewer: UTCZ,
        })[0].start,
      ).toISOString(),
    ).toBe("2026-11-10T03:30:00.000Z");
  });

  it("drops events with no usable DTSTART and events nested below the top level", () => {
    const parsed = parseIcs(
      cal(`${ev("UID:nostart@example.com", "SUMMARY:No start")}
${ev("UID:m13@example.com", "DTSTART:20261310T090000Z")}
${ev("UID:d32@example.com", "DTSTART:20261132T090000Z")}
BEGIN:X-WRAPPER
${ev("UID:nested@example.com", "DTSTART:20261110T090000Z")}
END:X-WRAPPER
${ev("UID:ok@example.com", "DTSTART:20261110T0900Z", "SUMMARY:Short time")}`),
    );
    expect(parsed.events).toHaveLength(1);
    const out = upcoming(parsed, {
      now: T("2026-11-09T12:00:00Z"),
      days: 7,
      limit: 5,
      viewer: UTCZ,
    });
    expect(out.map((e) => [e.title, e.start])).toEqual([["Short time", T("2026-11-10T09:00:00Z")]]);
  });
});

describe("upcoming: the spec sample", () => {
  it.each([
    ["CRLF", "\r\n"],
    ["LF", "\n"],
  ])("lists the series with exclusions and overrides (%s)", (_, eol) => {
    const out = list(cal(SAMPLE, eol));
    expect(out.map((e) => [new Date(e.start).toISOString(), e.title, e.recurring])).toEqual([
      ["2026-11-10T09:00:00.000Z", "Standup", true],
      ["2026-11-12T15:00:00.000Z", "Standup moved", true],
      ["2026-11-13T09:00:00.000Z", "Standup", true],
    ]);
    expect(out[0]).toMatchObject({
      id: `standup@example.com@${T("2026-11-10T09:00:00Z")}`,
      end: T("2026-11-10T09:15:00Z"),
      allDay: false,
      startDate: null,
      endDate: null,
      location: null,
      ongoing: false,
    });
    expect(out[1].end).toBe(T("2026-11-12T15:15:00Z"));
  });
});

describe("upcoming: window", () => {
  const timed = (uid: string, start: string, end?: string) =>
    ev(`UID:${uid}@example.com`, `SUMMARY:${uid}`, `DTSTART:${start}`, ...(end ? [`DTEND:${end}`] : []));

  it("keeps events in progress, drops finished ones, and treats zero-length events as instants", () => {
    const text = cal(
      [
        timed("finished", "20261109T100000Z", "20261109T110000Z"),
        timed("ends-now", "20261109T110000Z", "20261109T120000Z"),
        timed("running", "20261109T110000Z", "20261109T130000Z"),
        timed("instant-before", "20261109T115959Z"),
        timed("instant-now", "20261109T120000Z"),
      ].join("\n"),
    );
    const out = list(text);
    expect(out.map((e) => [e.title, e.ongoing])).toEqual([
      ["running", true],
      ["instant-now", false],
    ]);
    expect(out[1].end).toBeNull();
  });

  it("ends the window at local midnight of today in the viewer's zone plus N days", () => {
    const text = cal(
      [
        timed("utc-late", "20261109T235900Z"),
        timed("utc-midnight", "20261110T000000Z"),
        timed("tokyo-late", "20261109T145900Z"),
        timed("tokyo-midnight", "20261109T150000Z"),
      ].join("\n"),
    );
    expect(list(text, { days: 1 }).map((e) => e.title)).toEqual(["tokyo-late", "tokyo-midnight", "utc-late"]);
    // 12:00Z is 21:00 in Tokyo, so the one-day window closes at 15:00Z.
    expect(list(text, { days: 1, viewer: { kind: "iana", name: "Asia/Tokyo" } }).map((e) => e.title)).toEqual([
      "tokyo-late",
    ]);
  });

  it("sorts by start, all-day first on ties, then by title, dedupes ids and honours limit", () => {
    const text = cal(
      [
        ev("UID:b@example.com", "SUMMARY:beta", "DTSTART:20261110T000000Z"),
        ev("UID:a@example.com", "SUMMARY:Alpha", "DTSTART:20261110T000000Z"),
        ev("UID:z@example.com", "SUMMARY:Zed day", "DTSTART;VALUE=DATE:20261110"),
        ev("UID:a@example.com", "SUMMARY:Alpha", "DTSTART:20261110T000000Z"),
        ev("UID:early@example.com", "SUMMARY:Early", "DTSTART:20261109T180000Z"),
        ev("UID:late@example.com", "SUMMARY:Late", "DTSTART:20261111T180000Z"),
      ].join("\n"),
    );
    expect(list(text).map((e) => e.title)).toEqual(["Early", "Zed day", "Alpha", "beta", "Late"]);
    expect(list(text, { limit: 2 }).map((e) => e.title)).toEqual(["Early", "Zed day"]);
  });
});

describe("upcoming: fields", () => {
  it("unescapes text, falls back to Busy, and keeps a colon inside a quoted parameter", () => {
    const text = cal(
      [
        ev(
          "UID:esc@example.com",
          "DTSTART:20261110T090000Z",
          "SUMMARY:  Review\\, plan\\; ship \\\\ done\\nnext\\Nline  ",
          'LOCATION;ALTREP="https://example.com/rooms:4":Room 4\\, East wing',
        ),
        ev("UID:busy@example.com", "DTSTART:20261110T100000Z", "SUMMARY:", "LOCATION:"),
        ev("UID:none@example.com", "DTSTART:20261110T110000Z"),
      ].join("\n"),
    );
    const out = list(text);
    expect(out.map((e) => [e.title, e.location])).toEqual([
      ["Review, plan; ship \\ done\nnext\nline", "Room 4, East wing"],
      ["Busy", null],
      ["Busy", null],
    ]);
  });

  it("gives UID-less events distinct ids and all-day events date-based ids", () => {
    const text = cal(
      [
        ev("SUMMARY:Dentist", "DTSTART:20261110T090000Z"),
        ev("SUMMARY:Plumber", "DTSTART:20261110T090000Z"),
        ev("UID:trip@example.com", "SUMMARY:Trip", "DTSTART;VALUE=DATE:20261111"),
      ].join("\n"),
    );
    const out = list(text);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((e) => e.id)).size).toBe(3);
    expect(out.find((e) => e.title === "Trip")?.id).toBe("trip@example.com@2026-11-11");
  });
});

describe("upcoming: time zones", () => {
  it.each([
    ["UTC", "", "DTSTART:20261110T090000Z", UTCZ, "2026-11-10T09:00:00.000Z"],
    ["quoted TZID", "", 'DTSTART;TZID="Europe/Berlin":20261110T090000', UTCZ, "2026-11-10T08:00:00.000Z"],
    ["lower-case names", "", "dtstart;tzid=Europe/Berlin:20261110T090000", UTCZ, "2026-11-10T08:00:00.000Z"],
    ["Windows TZID", "", "DTSTART;TZID=W. Europe Standard Time:20261110T090000", UTCZ, "2026-11-10T08:00:00.000Z"],
    [
      "floating in calendar zone",
      "X-WR-TIMEZONE:America/New_York",
      "DTSTART:20261110T090000",
      UTCZ,
      "2026-11-10T14:00:00.000Z",
    ],
    [
      "floating in viewer zone",
      "",
      "DTSTART:20261110T090000",
      { kind: "iana", name: "Asia/Tokyo" },
      "2026-11-10T00:00:00.000Z",
    ],
    [
      "floating with unresolvable calendar zone",
      "X-WR-TIMEZONE:Mars/Olympus",
      "DTSTART:20261110T090000",
      { kind: "iana", name: "Asia/Tokyo" },
      "2026-11-10T00:00:00.000Z",
    ],
    [
      "unknown TZID in viewer zone",
      "",
      "DTSTART;TZID=Nowhere Special:20261110T090000",
      { kind: "iana", name: "Asia/Tokyo" },
      "2026-11-10T00:00:00.000Z",
    ],
    [
      "unknown TZID in calendar zone",
      "X-WR-TIMEZONE:America/New_York",
      "DTSTART;TZID=Nowhere Special:20261110T090000",
      UTCZ,
      "2026-11-10T14:00:00.000Z",
    ],
  ] as [string, string, string, Zone, string][])("reads %s", (_, header, dtstart, viewer, expected) => {
    const text = cal(`${header}\n${ev("UID:z@example.com", "SUMMARY:Z", dtstart)}`);
    expect(starts(text, { now: T("2026-11-09T00:00:00Z"), viewer })).toEqual([expected]);
  });

  it("keeps the wall time of a zoned daily series across the DST change", () => {
    const text = cal(
      ev(
        "UID:berlin@example.com",
        "SUMMARY:Gym",
        "DTSTART;TZID=Europe/Berlin:20261023T090000",
        "RRULE:FREQ=DAILY;COUNT=4",
      ),
    );
    expect(starts(text, { now: T("2026-10-22T00:00:00Z") })).toEqual([
      "2026-10-23T07:00:00.000Z",
      "2026-10-24T07:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
    ]);
  });
});

describe("upcoming: end and duration", () => {
  it.each([
    ["PT2H", 2 * 3600_000],
    ["P1DT2H30M", 26.5 * 3600_000],
    ["P1W", 7 * 86_400_000],
    ["PT15M", 15 * 60_000],
  ])("adds DURATION:%s", (dur, ms) => {
    const [e] = list(cal(ev("UID:d@example.com", "DTSTART:20261110T090000Z", `DURATION:${dur}`)));
    expect(e.end! - e.start).toBe(ms);
  });

  it("uses DTEND minus DTSTART even across zones, and ignores a negative duration", () => {
    const out = list(
      cal(
        [
          ev("UID:x@example.com", "SUMMARY:x", "DTSTART;TZID=Europe/Berlin:20261110T090000", "DTEND:20261110T093000Z"),
          ev("UID:neg@example.com", "SUMMARY:neg", "DTSTART:20261110T100000Z", "DURATION:-PT1H"),
        ].join("\n"),
      ),
    );
    expect(out.map((e) => [e.title, e.end])).toEqual([
      ["x", T("2026-11-10T09:30:00Z")],
      ["neg", null],
    ]);
  });

  it("treats DTEND of an all-day event as exclusive and defaults to one day", () => {
    const text = cal(
      [
        ev("UID:conf@example.com", "SUMMARY:Conference", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261113"),
        ev("UID:one@example.com", "SUMMARY:Holiday", "DTSTART:20261111"),
        ev("UID:bad@example.com", "SUMMARY:Backwards", "DTSTART;VALUE=DATE:20261112", "DTEND;VALUE=DATE:20261110"),
      ].join("\n"),
    );
    const byTitle = Object.fromEntries(list(text).map((e) => [e.title, e]));
    expect(byTitle.Conference).toMatchObject({
      allDay: true,
      startDate: "2026-11-10",
      endDate: "2026-11-12",
      start: T("2026-11-10T00:00:00Z"),
      end: T("2026-11-13T00:00:00Z"),
    });
    expect(byTitle.Holiday).toMatchObject({
      allDay: true,
      startDate: "2026-11-11",
      endDate: "2026-11-11",
      end: T("2026-11-12T00:00:00Z"),
    });
    expect(byTitle.Backwards).toMatchObject({
      startDate: "2026-11-12",
      endDate: "2026-11-12",
      end: T("2026-11-13T00:00:00Z"),
    });
  });

  it("anchors all-day dates to midnight in the viewer's zone and flags today's as ongoing", () => {
    const text = cal(
      [
        ev("UID:today@example.com", "SUMMARY:Today", "DTSTART;VALUE=DATE:20261109"),
        ev("UID:tom@example.com", "SUMMARY:Tomorrow", "DTSTART;VALUE=DATE:20261110"),
      ].join("\n"),
    );
    const out = list(text, {
      now: T("2026-11-09T18:00:00Z"),
      viewer: { kind: "iana", name: "America/New_York" },
    });
    expect(out.map((e) => [e.title, new Date(e.start).toISOString(), e.ongoing])).toEqual([
      ["Today", "2026-11-09T05:00:00.000Z", true],
      ["Tomorrow", "2026-11-10T05:00:00.000Z", false],
    ]);
  });
});

describe("upcoming: status, EXDATE, RDATE, overrides", () => {
  it("drops cancelled events and cancelled overrides", () => {
    const text = cal(
      [
        ev("UID:gone@example.com", "SUMMARY:Gone", "DTSTART:20261110T090000Z", "STATUS:CANCELLED"),
        ev("UID:yoga@example.com", "SUMMARY:Yoga", "DTSTART:20261110T180000Z", "RRULE:FREQ=DAILY;COUNT=3"),
        ev(
          "UID:yoga@example.com",
          "SUMMARY:Yoga",
          "RECURRENCE-ID:20261111T180000Z",
          "DTSTART:20261111T180000Z",
          "STATUS:CANCELLED",
        ),
      ].join("\n"),
    );
    expect(starts(text)).toEqual(["2026-11-10T18:00:00.000Z", "2026-11-12T18:00:00.000Z"]);
  });

  it("removes comma-listed and date-only EXDATEs from a timed series", () => {
    const text = cal(
      ev(
        "UID:walk@example.com",
        "SUMMARY:Walk",
        "DTSTART:20261110T070000Z",
        "RRULE:FREQ=DAILY;COUNT=6",
        "EXDATE:20261111T070000Z,20261113T070000Z",
        "EXDATE;VALUE=DATE:20261114",
      ),
    );
    expect(starts(text)).toEqual(["2026-11-10T07:00:00.000Z", "2026-11-12T07:00:00.000Z", "2026-11-15T07:00:00.000Z"]);
  });

  it("adds RDATE occurrences as recurring and ignores PERIOD RDATEs", () => {
    const text = cal(
      ev(
        "UID:extra@example.com",
        "SUMMARY:Clinic",
        "DTSTART:20261110T100000Z",
        "DURATION:PT1H",
        "RDATE:20261115T100000Z,20261116T143000Z",
        "RDATE;VALUE=PERIOD:20261117T100000Z/PT1H",
      ),
    );
    const out = list(text);
    expect(out.map((e) => new Date(e.start).toISOString())).toEqual([
      "2026-11-10T10:00:00.000Z",
      "2026-11-15T10:00:00.000Z",
      "2026-11-16T14:30:00.000Z",
    ]);
    expect(out.slice(1).every((e) => e.recurring)).toBe(true);
    expect(out[2].end).toBe(T("2026-11-16T15:30:00Z"));
  });

  it("marks a one-off event as not recurring", () => {
    expect(list(cal(ev("UID:once@example.com", "DTSTART:20261110T100000Z")))[0].recurring).toBe(false);
  });
});

describe("upcoming: RRULE", () => {
  const series = (dtstart: string, rrule: string) =>
    cal(ev("UID:r@example.com", "SUMMARY:R", `DTSTART:${dtstart}`, `RRULE:${rrule}`));
  const dates = (text: string, now: string, days: number) =>
    starts(text, { now: T(now), days }).map((s) => s.slice(0, 10));

  it("repeats a biweekly series on DTSTART's weekday", () => {
    expect(dates(series("20261002T170000Z", "FREQ=WEEKLY;INTERVAL=2"), "2026-11-01T00:00:00Z", 30)).toEqual([
      "2026-11-13",
      "2026-11-27",
    ]);
  });

  it("lists each BYDAY weekday per interval week", () => {
    expect(
      dates(series("20261109T070000Z", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR"), "2026-11-09T00:00:00Z", 21),
    ).toEqual(["2026-11-09", "2026-11-11", "2026-11-13", "2026-11-23", "2026-11-25", "2026-11-27"]);
  });

  it.each([
    ["MO", ["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"]],
    ["SU", ["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"]],
  ])("follows WKST=%s in the RFC 5545 biweekly example", (wkst, expected) => {
    const text = series("19970805T090000Z", `FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`);
    expect(dates(text, "1997-08-01T00:00:00Z", 60)).toEqual(expected);
  });

  it("skips months without a 31st", () => {
    expect(dates(series("20270131T120000Z", "FREQ=MONTHLY"), "2027-01-01T00:00:00Z", 120)).toEqual([
      "2027-01-31",
      "2027-03-31",
    ]);
  });

  it("counts negative BYMONTHDAY from the end of the month", () => {
    expect(dates(series("20261031T120000Z", "FREQ=MONTHLY;BYMONTHDAY=-1"), "2026-11-01T00:00:00Z", 120)).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
  });

  it("finds the last Friday of each month", () => {
    expect(dates(series("20261030T100000Z", "FREQ=MONTHLY;BYDAY=-1FR"), "2026-10-01T00:00:00Z", 90)).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25",
    ]);
  });

  it("finds the fourth Thursday of November each year", () => {
    expect(dates(series("20251127T150000Z", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), "2026-11-01T00:00:00Z", 60)).toEqual([
      "2026-11-26",
    ]);
  });

  it("lets BYDAY limit BYMONTHDAY (Friday the 13th)", () => {
    expect(
      dates(series("20261113T180000Z", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"), "2026-11-01T00:00:00Z", 400),
    ).toEqual(["2026-11-13", "2027-08-13"]);
  });

  it("includes an UNTIL date and stops after it", () => {
    const text = cal(
      ev("UID:u@example.com", "SUMMARY:Camp", "DTSTART;VALUE=DATE:20261110", "RRULE:FREQ=DAILY;UNTIL=20261112"),
    );
    expect(list(text).map((e) => e.startDate)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
  });

  it("counts COUNT from DTSTART, including occurrences before the window", () => {
    const text = series("20261106T090000Z", "FREQ=DAILY;COUNT=5");
    expect(starts(text)).toEqual(["2026-11-10T09:00:00.000Z"]);
  });

  it.each([
    "FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1",
    "FREQ=DAILY;BYHOUR=9,17",
    "FREQ=HOURLY;INTERVAL=4",
    "FREQ=YEARLY;BYWEEKNO=20",
  ])("shows only DTSTART for unsupported rule %s", (rule) => {
    const out = list(series("20261110T090000Z", rule));
    expect(out.map((e) => [new Date(e.start).toISOString(), e.recurring])).toEqual([
      ["2026-11-10T09:00:00.000Z", false],
    ]);
  });

  it("expands a daily series that started in 1990 quickly", { timeout: 2000 }, () => {
    const text = series("19900101T080000Z", "FREQ=DAILY");
    expect(starts(text, { now: T("2026-11-09T00:00:00Z"), days: 3 })).toEqual([
      "2026-11-09T08:00:00.000Z",
      "2026-11-10T08:00:00.000Z",
      "2026-11-11T08:00:00.000Z",
    ]);
  });
});
