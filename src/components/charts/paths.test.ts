import { describe, expect, it } from "vitest";
import { niceMax, seriesPath, sparkPath, type Point } from "./paths";

const opts = { tMin: 0, tMax: 100, x: (t: number) => t, y: (v: number) => 50 - v, floor: 50 };

describe("seriesPath", () => {
  it("draws one run for evenly spaced samples", () => {
    const pts: Point[] = [
      [0, 1],
      [10, 2],
      [20, 3],
    ];
    const r = seriesPath(pts, opts);
    expect(r.d).toBe("M0.0,49.0L10.0,48.0L20.0,47.0");
    expect(r.lonely).toEqual([]);
  });

  it("breaks the line at a sample with no value instead of drawing it as zero", () => {
    const pts: Point[] = [
      [0, 5],
      [10, 5],
      [20, Number.NaN],
      [30, 5],
      [40, 5],
    ];
    const r = seriesPath(pts, opts);
    expect(r.d).not.toContain("NaN");
    expect(r.d).toBe("M0.0,45.0L10.0,45.0M30.0,45.0L40.0,45.0");
    expect(r.pts).toHaveLength(4);
  });

  it("keeps a lone sample between gaps as a dot", () => {
    const pts: Point[] = [
      [0, 5],
      [10, 5],
      [20, Number.NaN],
      [30, 7],
      [40, Number.NaN],
      [50, 5],
      [60, 5],
    ];
    expect(seriesPath(pts, opts).lonely).toEqual([[30, 7]]);
  });

  it("closes the area under each run", () => {
    const pts: Point[] = [
      [0, 5],
      [10, 5],
      [20, Number.NaN],
      [30, 5],
      [40, 5],
    ];
    const r = seriesPath(pts, { ...opts, area: true });
    expect(r.area.match(/Z/g)).toHaveLength(2);
    expect(r.area).not.toContain("NaN");
  });

  it("ignores samples outside the window", () => {
    const r = seriesPath(
      [
        [-50, 1],
        [50, 1],
        [500, 1],
      ],
      opts,
    );
    expect(r.pts).toEqual([[50, 1]]);
  });
});

describe("sparkPath", () => {
  it("lifts the pen over missing values", () => {
    const d = sparkPath([1, Number.NaN, 1], 28, 2);
    expect(d).not.toContain("NaN");
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("draws nothing when every value is missing", () => {
    expect(sparkPath([Number.NaN, Number.NaN], 28)).toBe("");
  });
});

describe("niceMax", () => {
  it("rounds up to a readable step", () => {
    expect(niceMax(73)).toBe(80);
    expect(niceMax(0.0042)).toBeCloseTo(0.005);
  });

  it("falls back to 1 for nothing or garbage", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});
