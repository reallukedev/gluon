import { describe, expect, it } from "vitest";
import {
  UTC,
  type Wall,
  type Zone,
  dayNumber,
  daysInMonth,
  fromDayNumber,
  isIanaZone,
  isoDate,
  resolveTzid,
  utcToWall,
  weekday,
  zoneName,
  zonedToUtc,
} from "./tz";

const iana = (name: string): Zone => ({ kind: "iana", name });
const wall = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): Wall => ({
  y,
  m,
  d,
  h,
  mi,
  s,
});
const iso = (ms: number) => new Date(ms).toISOString();

describe("isIanaZone", () => {
  it.each([
    ["UTC", true],
    ["Europe/Berlin", true],
    ["America/Argentina/Buenos_Aires", true],
    ["", false],
    ["Mars/Olympus", false],
    ["Not a zone", false],
    [`Europe/${"x".repeat(70)}`, false],
  ])("%j -> %s", (tz, ok) => {
    expect(isIanaZone(tz)).toBe(ok);
  });
});

describe("zonedToUtc", () => {
  it("applies fixed offsets and ordinary IANA offsets on both sides of the year", () => {
    expect(
      iso(
        zonedToUtc(wall(2026, 11, 10, 9), {
          kind: "fixed",
          offsetMs: 19_800_000,
        }),
      ),
    ).toBe("2026-11-10T03:30:00.000Z");
    expect(iso(zonedToUtc(wall(2026, 11, 10, 9), iana("Europe/Berlin")))).toBe("2026-11-10T08:00:00.000Z");
    expect(iso(zonedToUtc(wall(2026, 7, 1, 9), iana("Europe/Berlin")))).toBe("2026-07-01T07:00:00.000Z");
    expect(iso(zonedToUtc(wall(2026, 11, 10, 9), iana("America/New_York")))).toBe("2026-11-10T14:00:00.000Z");
    expect(zonedToUtc(wall(2026, 2, 28, 23, 59, 58), UTC)).toBe(Date.UTC(2026, 1, 28, 23, 59, 58));
  });

  const springGap = (name: string, w: Wall, expected: string) => () => {
    const ms = zonedToUtc(w, iana(name));
    expect(iso(ms)).toBe(expected);
    const back = utcToWall(ms, iana(name));
    expect(back.h).toBe(3);
    expect(back.mi).toBe(30);
  };

  it(
    "moves a wall time in the Europe/Berlin spring gap forward",
    springGap("Europe/Berlin", wall(2026, 3, 29, 2, 30), "2026-03-29T01:30:00.000Z"),
  );

  // Suspected bug: lands on 01:30 EST (06:30Z), the earlier side of the gap.
  it.fails(
    "moves a wall time in the America/New_York spring gap forward",
    springGap("America/New_York", wall(2026, 3, 8, 2, 30), "2026-03-08T07:30:00.000Z"),
  );

  it("picks the first (EDT) occurrence of an ambiguous America/New_York wall time", () => {
    expect(iso(zonedToUtc(wall(2026, 11, 1, 1, 30), iana("America/New_York")))).toBe("2026-11-01T05:30:00.000Z");
  });

  // Suspected bug: returns 02:30 CET (01:30Z), the second occurrence.
  it.fails("picks the first (CEST) occurrence of an ambiguous Europe/Berlin wall time", () => {
    expect(iso(zonedToUtc(wall(2026, 10, 25, 2, 30), iana("Europe/Berlin")))).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("utcToWall", () => {
  it("shifts by a fixed offset, including a negative one across midnight", () => {
    expect(
      utcToWall(Date.UTC(2026, 0, 1, 1, 15, 42), {
        kind: "fixed",
        offsetMs: -10_800_000,
      }),
    ).toEqual(wall(2025, 12, 31, 22, 15, 42));
  });

  it("reports midnight as hour 0", () => {
    expect(utcToWall(Date.parse("2026-11-09T23:00:00Z"), iana("Europe/Berlin"))).toEqual(wall(2026, 11, 10, 0, 0, 0));
    expect(utcToWall(Date.parse("2026-11-10T00:00:00Z"), UTC).h).toBe(0);
  });

  it("drops milliseconds but keeps seconds", () => {
    expect(utcToWall(Date.parse("2026-06-15T12:34:56.789Z"), UTC)).toEqual(wall(2026, 6, 15, 12, 34, 56));
  });

  it.each<[string, Zone, Wall]>([
    ["Asia/Kolkata", iana("Asia/Kolkata"), wall(2026, 1, 31, 23, 59, 59)],
    ["Australia/Sydney", iana("Australia/Sydney"), wall(2026, 7, 4, 6, 7, 8)],
    ["America/Los_Angeles", iana("America/Los_Angeles"), wall(2024, 2, 29, 12, 0, 1)],
    ["Pacific/Chatham", iana("Pacific/Chatham"), wall(2026, 12, 25, 18, 45, 0)],
    ["fixed -03:30", { kind: "fixed", offsetMs: -12_600_000 }, wall(2026, 3, 1, 0, 10, 0)],
  ])("round-trips an ordinary wall time in %s", (_, z, w) => {
    expect(utcToWall(zonedToUtc(w, z), z)).toEqual(w);
  });
});

describe("calendar arithmetic", () => {
  it("numbers days from the Unix epoch and back", () => {
    expect(dayNumber(1970, 1, 1)).toBe(0);
    expect(dayNumber(1970, 1, 2)).toBe(1);
    expect(dayNumber(1969, 12, 31)).toBe(-1);
    for (const [y, m, d] of [
      [2024, 2, 29],
      [2000, 2, 29],
      [1900, 3, 1],
      [1969, 1, 1],
      [2099, 12, 31],
      [100, 3, 1],
    ]) {
      expect(fromDayNumber(dayNumber(y, m, d))).toEqual({ y, m, d });
    }
    expect(dayNumber(2024, 3, 1) - dayNumber(2024, 2, 28)).toBe(2);
  });

  // Suspected bug: years 0-99 are read as 1900-1999 (dayNumber(1, 1, 1) === -25202).
  it.fails("handles years below 100", () => {
    expect(dayNumber(1, 1, 1)).toBe(-719_162);
    expect(fromDayNumber(dayNumber(5, 1, 1))).toEqual({ y: 5, m: 1, d: 1 });
  });

  it("gives weekdays 0-6 for positive and negative day numbers", () => {
    expect(weekday(dayNumber(1970, 1, 1))).toBe(4);
    expect(weekday(dayNumber(2026, 11, 9))).toBe(1);
    expect(weekday(-1)).toBe(3);
    for (let n = -30; n < 0; n++) {
      const w = weekday(n);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(6);
      expect(w).toBe(new Date(n * 86_400_000).getUTCDay());
    }
  });

  it("formats ISO dates with zero padding", () => {
    expect(isoDate(2026, 3, 7)).toBe("2026-03-07");
    expect(isoDate(5, 1, 1)).toBe("0005-01-01");
    expect(isoDate(2026, 12, 31)).toBe("2026-12-31");
  });

  it.each([
    [2026, 2, 28],
    [2024, 2, 29],
    [1900, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
    [2026, 1, 31],
  ])("daysInMonth(%i, %i) = %i", (y, m, n) => {
    expect(daysInMonth(y, m)).toBe(n);
  });
});

describe("resolveTzid", () => {
  it.each([null, undefined, ""])("returns null for %j", (v) => {
    expect(resolveTzid(v)).toBeNull();
  });

  it.each([
    [' "Europe/Berlin" ', "Europe/Berlin"],
    ["America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"],
    ["W. Europe Standard Time", "Europe/Berlin"],
    ["GMT Standard Time", "Europe/London"],
    ["Pacific Standard Time", "America/Los_Angeles"],
    ["Eastern Standard Time", "America/New_York"],
    ["Tokyo Standard Time", "Asia/Tokyo"],
    ["AUS Eastern Standard Time", "Australia/Sydney"],
    ["India Standard Time", "Asia/Kolkata"],
    ["Coordinated Universal Time", "UTC"],
    ["/mozilla.org/20050126_1/Europe/Berlin", "Europe/Berlin"],
    ["/citadel.org/20190914_1/America/New_York", "America/New_York"],
  ])("maps %j to IANA %s", (tzid, name) => {
    expect(resolveTzid(tzid)).toEqual({ kind: "iana", name });
  });

  it.each([
    ["UTC+2", 7_200_000],
    ["GMT-3", -10_800_000],
    ["utc-3", -10_800_000],
    ["UTC+05:30", 19_800_000],
    ["GMT+0530", 19_800_000],
  ])("reads %j as a fixed offset", (tzid, offsetMs) => {
    expect(resolveTzid(tzid)).toEqual({ kind: "fixed", offsetMs });
  });

  it.each(["My Custom Zone", "Mars/Olympus"])("gives up on %j", (tzid) => {
    expect(resolveTzid(tzid)).toBeNull();
  });
});

describe("zoneName", () => {
  it.each([
    [19_800_000, "UTC+05:30"],
    [-10_800_000, "UTC-03:00"],
    [-12_600_000, "UTC-03:30"],
    [0, "UTC+00:00"],
  ])("names fixed offset %i as %s", (offsetMs, name) => {
    expect(zoneName({ kind: "fixed", offsetMs })).toBe(name);
  });

  it("names IANA zones by their name", () => {
    expect(zoneName(iana("Asia/Tokyo"))).toBe("Asia/Tokyo");
    expect(zoneName(UTC)).toBe("UTC");
  });
});
