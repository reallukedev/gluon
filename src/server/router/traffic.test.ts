import { describe, expect, it } from "vitest";
import { buckets, compare, current, rates, type Sample, type Seen } from "./traffic";

const T = Date.parse("2026-10-25T20:00:00Z");
const BOOT = T - 6 * 86_400_000;
const s = (sec: number, rx: number, tx: number, boot = BOOT): Sample => ({ t: T + sec * 1000, rx, tx, boot });

describe("throughput from byte counters", () => {
  it("divides each counter step by the time between readings", () => {
    expect(rates([s(0, 1_000_000, 500_000), s(15, 16_000_000, 2_000_000)])).toEqual([{ t: T + 15_000, rx: 1_000_000, tx: 100_000 }]);
  });

  it("gives no rate across a router restart, then picks up from the new counters", () => {
    const reboot = T + 60_000;
    const out = rates([s(0, 9e11, 5e10), s(30, 9.0001e11, 5.00001e10), s(120, 4_000_000, 1_000_000, reboot), s(135, 7_000_000, 1_300_000, reboot)]);
    expect(out[1]).toEqual({ t: T + 120_000, rx: null, tx: null });
    expect(out[2]).toEqual({ t: T + 135_000, rx: 200_000, tx: 20_000 });
  });

  it("gives no rate when the counters go backwards with the same boot (someone pressed Clear Statistics)", () => {
    expect(rates([s(0, 5e9, 1e9), s(15, 1000, 500)])).toEqual([{ t: T + 15_000, rx: null, tx: null }]);
  });

  it("gives no rate over a gap long enough to mean nothing", () => {
    expect(rates([s(0, 1e6, 1e6), s(11 * 60, 2e6, 2e6)])[0]!.rx).toBeNull();
  });

  it("calls a rate 'now' only when it was measured recently", () => {
    const series = [s(0, 0, 0), s(15, 15_000, 1500)];
    expect(current(series, T + 20_000)).toEqual({ rx: 1000, tx: 100, at: T + 15_000 });
    expect(current(series, T + 15_000 + 4 * 60_000)).toBeNull();
    expect(current([s(0, 0, 0)], T)).toBeNull();
  });

  it("averages per bucket by bytes over time, whatever the reading cadence, and leaves restart buckets empty", () => {
    // Bucket 1: two 15 s readings at 1 MB/s and 3 MB/s average to 2 MB/s. Bucket 2: one 60 s reading.
    // Bucket 3: the router restarted. Bucket 4: nothing was read.
    const reboot = T + 170_000;
    const series = [s(0, 0, 0), s(15, 15e6, 0), s(30, 60e6, 0), s(90, 120e6, 6e6), s(175, 1e6, 0, reboot)];
    expect(buckets(series, T, T + 240_000, 60_000)).toEqual([
      { t: T + 60_000, rx: 2e6, tx: 0 },
      { t: T + 120_000, rx: 1e6, tx: 1e5 },
      { t: T + 180_000, rx: null, tx: null },
      { t: T + 240_000, rx: null, tx: null },
    ]);
  });
});

describe("noticing restarts and broadband drops", () => {
  const r = (sec: number, broadband: boolean | null, boot: number | null = BOOT) => ({ at: T + sec * 1000, boot, broadband });

  it("takes the first reading as a baseline, with nothing to report", () => {
    expect(compare(null, r(0, true)).changes).toEqual([]);
  });

  it("reports a restart once two readings agree the boot time moved forward", () => {
    const a = compare(null, r(0, true)).seen;
    const newBoot = T + 100_000;
    const b = compare(a, r(200, true, newBoot));
    expect(b.changes).toEqual([]);
    const c = compare(b.seen, r(215, true, newBoot + 1000));
    expect(c.changes).toEqual([{ kind: "restarted", at: newBoot, upFor: newBoot - BOOT }]);
    expect(compare(c.seen, r(230, true, newBoot)).changes).toEqual([]);
  });

  it("ignores one stale page whose frozen uptime makes the boot time look later", () => {
    const a = compare(null, r(0, true)).seen;
    const stale = compare(a, r(90, true, BOOT + 150_000));
    const fresh = compare(stale.seen, r(120, true, BOOT + 500));
    expect([...stale.changes, ...fresh.changes]).toEqual([]);
    expect(fresh.seen.boot).toBe(BOOT);
  });

  it("needs broadband down on two readings in a row, and dates the drop from the first", () => {
    let seen: Seen = compare(null, r(0, true)).seen;
    const one = compare(seen, r(15, false));
    expect(one.changes).toEqual([]);
    const blip = compare(one.seen, r(30, true));
    expect(blip.changes).toEqual([]);
    seen = compare(compare(blip.seen, r(45, false)).seen, r(60, false)).seen;
    expect(seen.broadband).toBe(false);
    const back = compare(seen, r(300, true));
    expect(back.changes).toEqual([{ kind: "broadband-up", at: T + 300_000, downFor: 255_000 }]);
  });

  it("reports the drop itself once", () => {
    const a = compare(compare(compare(null, r(0, true)).seen, r(15, false)).seen, r(30, false));
    expect(a.changes).toEqual([{ kind: "broadband-down", at: T + 15_000 }]);
    expect(compare(a.seen, r(45, false)).changes).toEqual([]);
  });
});
