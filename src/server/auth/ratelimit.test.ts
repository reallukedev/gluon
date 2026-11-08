import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-rl-"));
vi.stubEnv("GLUON_DATA", dataDir);
const db = await import("@/server/db");
const { burst, clearThrottle, guard, oneAtATime, pruneAttempts, recordAttempt, retryAfter, waitText } =
  await import("./ratelimit");

const T0 = new Date("2026-11-08T10:00:00Z");
const HOME_IP = "192.168.1.20";
const AWAY_IP = "203.0.113.7";
const count = () => db.one<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts")!.n;

function fail(subject: string, ip: string, times: number, zone: "home" | "away" = "home", gapMs = 1000) {
  const results = [];
  for (let i = 0; i < times; i++) {
    if (i > 0) vi.advanceTimersByTime(gapMs);
    results.push(recordAttempt(subject, ip, false, zone));
  }
  return results;
}

beforeEach(() => {
  db.run("DELETE FROM login_attempts");
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("account throttle", () => {
  it.each([
    ["home", HOME_IP, [0, 0, 0, 0, 30, 60, 120, 240]],
    ["away", AWAY_IP, [0, 0, 0, 0, 60, 120, 240, 480]],
  ] as const)("doubles the wait after five %s failures", (zone, ip, waits) => {
    const seen: number[] = [];
    const started: boolean[] = [];
    const failures: number[] = [];
    for (let i = 0; i < waits.length; i++) {
      if (i > 0) vi.advanceTimersByTime(1000);
      const r = recordAttempt("login:maya", ip, false, zone);
      started.push(r.startedThrottle);
      failures.push(r.failures);
      seen.push(retryAfter("login:maya", ip, zone));
    }
    expect(seen).toEqual(waits);
    expect(failures).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(started).toEqual([false, false, false, false, true, false, false, false]);
  });

  it.each([
    ["home", HOME_IP, 900],
    ["away", AWAY_IP, 3600],
  ] as const)("caps the %s wait at %i seconds", (zone, ip, cap) => {
    fail("login:omar", ip, 14, zone);
    expect(retryAfter("login:omar", ip, zone)).toBe(cap);
  });

  it("counts down from the latest failure and lifts after the window", () => {
    fail("login:maya", HOME_IP, 5);
    vi.advanceTimersByTime(10_000);
    expect(retryAfter("login:maya", HOME_IP)).toBe(20);
    vi.advanceTimersByTime(250);
    expect(retryAfter("login:maya", HOME_IP)).toBe(20);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(retryAfter("login:maya", HOME_IP, "home")).toBe(0);
  });

  it("keeps away failures counted for a day", () => {
    fail("login:maya", AWAY_IP, 6, "away");
    vi.advanceTimersByTime(20 * 60_000);
    // The wait itself has passed, but the failures still count, so the next one is throttled harder.
    expect(retryAfter("login:maya", AWAY_IP, "away")).toBe(0);
    expect(recordAttempt("login:maya", AWAY_IP, false, "away").failures).toBe(7);
    expect(retryAfter("login:maya", AWAY_IP, "away")).toBe(240);
  });

  it("keeps zones apart and treats subjects case-insensitively", () => {
    fail("login:Maya", AWAY_IP, 5, "away");
    expect(retryAfter("login:maya", AWAY_IP, "away")).toBe(60);
    expect(retryAfter("login:maya", HOME_IP, "home")).toBe(0);
    expect(retryAfter("login:maya", HOME_IP)).toBe(0);
    expect(retryAfter("login:other", "198.51.100.4", "away")).toBe(0);
  });

  it("clears both zones on success but keeps the IP's failures", () => {
    fail("login:maya", HOME_IP, 5, "home");
    fail("login:maya", AWAY_IP, 5, "away");
    expect(recordAttempt("login:MAYA", HOME_IP, true, "home")).toEqual({
      failures: 0,
      startedThrottle: false,
    });
    expect(retryAfter("login:maya", HOME_IP, "home")).toBe(0);
    expect(retryAfter("login:maya", AWAY_IP, "away")).toBe(0);
    expect(recordAttempt("login:maya", AWAY_IP, false, "away").failures).toBe(1);
    // The 5 home failures still count against HOME_IP: 25 more make 30.
    for (let n = 0; n < 25; n++) recordAttempt(`login:guest${n}`, HOME_IP, false);
    expect(retryAfter("login:fresh", HOME_IP)).toBeGreaterThan(800);
  });

  it("returns the larger of the account wait and the IP wait", () => {
    for (let i = 0; i < 24; i++) recordAttempt(`login:user${i}`, HOME_IP, false);
    fail("login:maya", HOME_IP, 6);
    // 30 failures from this IP now, the oldest 5 s ago.
    expect(retryAfter("login:maya", HOME_IP)).toBe(895);
    expect(retryAfter("login:maya", "192.168.1.21")).toBe(60);
  });
});

describe("IP caps", () => {
  it("blocks an IP after 30 failures in 15 minutes, for any subject", () => {
    for (let i = 0; i < 29; i++) recordAttempt(`login:u${i}`, AWAY_IP, false, "home");
    expect(retryAfter("login:fresh", AWAY_IP)).toBe(0);
    recordAttempt("login:u29", AWAY_IP, false, "home");
    expect(retryAfter("login:fresh", AWAY_IP)).toBe(900);
    expect(retryAfter("login:fresh", AWAY_IP, "away")).toBe(900);
    expect(retryAfter("login:fresh", "198.51.100.30")).toBe(0);
    vi.advanceTimersByTime(15 * 60_000 + 1000);
    expect(retryAfter("login:fresh", AWAY_IP)).toBe(0);
  });

  it("blocks an away IP after 100 failures in a day, but only for away checks", () => {
    // One a minute keeps every 15-minute window well under 30.
    for (let i = 0; i < 99; i++) {
      recordAttempt(`login:spray${i}`, AWAY_IP, false, "away");
      vi.advanceTimersByTime(60_000);
    }
    expect(retryAfter("login:fresh", AWAY_IP, "away")).toBe(0);
    recordAttempt("login:spray99", AWAY_IP, false, "away");
    expect(retryAfter("login:fresh", AWAY_IP, "away")).toBe(86_400 - 99 * 60);
    expect(retryAfter("login:fresh", AWAY_IP, "home")).toBe(0);
  });
});

describe("waitText", () => {
  it.each([
    [0, "0 seconds"],
    [1, "1 second"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [900, "15 minutes"],
    [3600, "1 hour"],
    [7200, "2 hours"],
    [86400, "24 hours"],
  ])("%i -> %j", (s, text) => {
    expect(waitText(s)).toBe(text);
  });
});

describe("guard", () => {
  it("lets a try through when nothing is throttled", () => {
    fail("login:maya", HOME_IP, 4);
    expect(() => guard("login:maya", HOME_IP, "home")).not.toThrow();
  });

  it("throws a 429 naming the wait", () => {
    fail("login:maya", HOME_IP, 5);
    let err: unknown;
    try {
      guard("login:maya", HOME_IP, "home", "sign-in attempts");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: "rate_limited",
      status: 429,
      details: { retryAfter: 30 },
      message: "Too many sign-in attempts. Try again in 30 seconds.",
    });
    vi.advanceTimersByTime(2000);
    fail("login:maya", HOME_IP, 2, "home", 1000);
    expect(() => guard("login:maya", HOME_IP, "home")).toThrow("Too many attempts. Try again in 2 minutes.");
  });
});

describe("oneAtATime", () => {
  it("rejects a second concurrent call for the same subject and zone without running it", async () => {
    vi.useRealTimers();
    let release!: (v: string) => void;
    const first = oneAtATime("login:Maya", "home", () => new Promise<string>((r) => (release = r)));
    const second = vi.fn(async () => "second");
    await expect(oneAtATime("login:maya", "home", second)).rejects.toMatchObject({
      code: "signin_busy",
      message: "Another sign-in to this account is being checked. Try again in a moment.",
      status: 429,
    });
    expect(second).not.toHaveBeenCalled();
    await expect(oneAtATime("login:maya", "away", async () => "away ok")).resolves.toBe("away ok");
    await expect(oneAtATime("login:omar", "home", async () => "omar ok")).resolves.toBe("omar ok");
    release("first done");
    await expect(first).resolves.toBe("first done");
    await expect(oneAtATime("login:maya", "home", second)).resolves.toBe("second");
  });

  it("releases the lock when fn rejects", async () => {
    vi.useRealTimers();
    await expect(
      oneAtATime("login:lin", "away", async () => {
        throw new Error("wrong password");
      }),
    ).rejects.toThrow("wrong password");
    await expect(oneAtATime("login:lin", "away", async () => 42)).resolves.toBe(42);
  });
});

describe("burst", () => {
  it("follows the spec example and does not count refused calls", () => {
    const key = "burst:spec-example";
    expect(burst(key, 2, 10_000)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(burst(key, 2, 10_000)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(burst(key, 2, 10_000)).toBe(8);
    vi.advanceTimersByTime(1000);
    expect(burst(key, 2, 10_000)).toBe(7);
    vi.advanceTimersByTime(7001);
    expect(burst(key, 2, 10_000)).toBe(0);
    vi.advanceTimersByTime(499);
    expect(burst(key, 2, 10_000)).toBe(1);
  });

  it("keeps keys independent", () => {
    expect(burst("burst:a-indep", 1, 60_000)).toBe(0);
    expect(burst("burst:a-indep", 1, 60_000)).toBe(60);
    expect(burst("burst:b-indep", 1, 60_000)).toBe(0);
  });
});

describe("clearThrottle", () => {
  it("forgets a login subject in both zones, case-insensitively, and nothing else", () => {
    fail("login:zed", AWAY_IP, 5, "away");
    fail("login:zed", HOME_IP, 5, "home");
    fail("login:amy", AWAY_IP, 5, "away");
    fail("reauth:zed", HOME_IP, 5, "home");
    clearThrottle("Zed");
    expect(retryAfter("login:zed", "198.51.100.9", "away")).toBe(0);
    expect(retryAfter("login:zed", "192.168.1.99", "home")).toBe(0);
    expect(retryAfter("login:amy", "198.51.100.9", "away")).toBeGreaterThan(0);
    expect(retryAfter("reauth:zed", "192.168.1.99", "home")).toBeGreaterThan(0);
  });
});

describe("pruneAttempts", () => {
  it("does nothing on an empty table", () => {
    expect(() => pruneAttempts()).not.toThrow();
    expect(count()).toBe(0);
  });

  it("deletes attempts older than 48 hours only", () => {
    recordAttempt("login:old", AWAY_IP, false, "away");
    const perFailure = count();
    vi.advanceTimersByTime(47 * 3600_000);
    recordAttempt("login:mid", AWAY_IP, false, "away");
    pruneAttempts();
    expect(count()).toBe(2 * perFailure);
    vi.advanceTimersByTime(2 * 3600_000);
    recordAttempt("login:new", AWAY_IP, false, "away");
    pruneAttempts();
    expect(count()).toBe(2 * perFailure);
  });
});
