import { describe, expect, it } from "vitest";
import { formatBytes, formatDateTime, formatDuration, formatPercent, formatRate, plural } from "./format";

describe("formatPercent", () => {
  it("never rounds a nearly full value up to 100%", () => {
    expect(formatPercent(99.6)).toBe("99%");
    expect(formatPercent(99.96, 1)).toBe("99.9%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("never rounds a small non-zero value down to 0%", () => {
    expect(formatPercent(0.04)).toBe("<0.1%");
    expect(formatPercent(0.004, 1)).toBe("<0.1%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("rounds ordinary values normally", () => {
    expect(formatPercent(62.5)).toBe("63%");
    expect(formatPercent(12.34, 1)).toBe("12.3%");
  });

  it("says unknown for missing or broken values", () => {
    expect(formatPercent(null)).toBe("Unknown");
    expect(formatPercent(undefined)).toBe("Unknown");
    expect(formatPercent(Number.NaN)).toBe("Unknown");
  });
});

describe("formatBytes", () => {
  it("steps up a unit instead of printing 1000 of the smaller one", () => {
    expect(formatBytes(999_700)).toBe("1.0 MB");
    expect(formatBytes(1023.8 * 1024, "binary")).toBe("1.0 MiB");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("labels decimal and binary units correctly", () => {
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(1_572_864, "binary")).toBe("1.5 MiB");
  });

  it("keeps the sign and says unknown for broken input", () => {
    expect(formatBytes(-2_000)).toBe("−2.0 kB");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("Unknown");
    expect(formatBytes(null)).toBe("Unknown");
  });

  it("honours explicit digits", () => {
    expect(formatBytes(1_234_567, "decimal", 2)).toBe("1.23 MB");
  });
});

describe("formatRate", () => {
  it("formats bits and bytes", () => {
    expect(formatRate(125_000, "bits")).toBe("1.0 Mb/s");
    expect(formatRate(4_200_000)).toBe("4.2 MB/s");
    expect(formatRate(Number.NaN)).toBe("Unknown");
  });
});

describe("formatDuration", () => {
  it("clamps negatives and keeps two parts", () => {
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(5025)).toBe("1 h 23 m");
    expect(formatDuration(3 * 86400 + 4 * 3600 + 7)).toBe("3 d 4 h");
  });
});

describe("plural", () => {
  it("uses the singular only for exactly one", () => {
    expect(plural(1, "app")).toBe("1 app");
    expect(plural(0, "app")).toBe("0 apps");
    expect(plural(2, "person", "people")).toBe("2 people");
  });
});

describe("formatDateTime", () => {
  const prefs = { bytes: "decimal", temperature: "c", rates: "bytes", clock: "24", dateOrder: "ymd" } as const;
  // 23:30 UTC on 1 March is already 2 March in Tokyo and still 1 March in New York.
  const ts = Date.UTC(2030, 2, 1, 23, 30);
  const now = Date.UTC(2030, 2, 2, 6, 0);

  it("decides today in the chosen time zone", () => {
    expect(formatDateTime(ts, { ...prefs, timezone: "Asia/Tokyo" }, now)).toMatch(/^Today /);
    expect(formatDateTime(ts, { ...prefs, timezone: "America/New_York" }, now)).not.toMatch(/^Today/);
  });

  it("says unknown for a broken timestamp", () => {
    expect(formatDateTime(Number.NaN, { ...prefs, timezone: "UTC" })).toBe("Unknown");
  });
});
