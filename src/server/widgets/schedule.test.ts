import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  existing: new Set<string>(["/usr/bin/systemctl"]),
  json: null as string | null,
  table: "",
  offset: "+0000\n" as string | null,
  show: "" as string | null,
  updates: {
    auto: false,
    channel: "stable",
    hour: 3,
    nightlyTiming: "hour",
    method: "github",
  } as Record<string, unknown>,
  routes: [] as unknown[],
  network: null as null | (() => Promise<{ routes: unknown[] }>),
}));

const host = vi.hoisted(() =>
  vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === "systemctl" && args.includes("--output=json")) {
      if (state.json === null) throw new Error("unknown option --output");
      return { stdout: state.json };
    }
    if (cmd === "systemctl" && args.includes("--no-legend")) return { stdout: state.table };
    if (cmd === "date") {
      if (state.offset === null) throw new Error("date: not found");
      return { stdout: state.offset };
    }
    if (cmd === "systemctl" && args[0] === "show") {
      if (state.show === null) throw new Error("systemctl show failed");
      return { stdout: state.show };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  }),
);

vi.mock("@/server/host/exec", () => ({
  host,
  CommandError: class extends Error {},
}));
vi.mock("@/server/host/paths", () => ({
  hostExists: (p: string) => state.existing.has(p),
}));
vi.mock("@/server/settings", () => ({
  getSetting: (key: string) => (key === "updates" ? state.updates : undefined),
}));
vi.mock("@/server/integrations/cache", () => ({
  cached: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => ({
    value: await fn(),
    fetchedAt: Date.now(),
    stale: null,
  }),
}));
vi.mock("@/server/network/status", () => ({
  networkStatus: async () => (state.network ? state.network() : { routes: state.routes }),
}));

const { scheduleAvailable, scheduleData } = await import("./schedule");

const us = (iso: string) => Date.parse(iso) * 1000;
const block = (id: string, description: string, result?: string) =>
  [`Id=${id}`, `Description=${description}`, ...(result === undefined ? [] : [`Result=${result}`])].join("\n");

async function items() {
  const data = await scheduleData();
  if (!data.available) throw new Error(`unavailable: ${data.reason}`);
  return data.items;
}
const byId = async () => Object.fromEntries((await items()).map((i) => [i.id, i]));

beforeEach(() => {
  host.mockClear();
  state.existing = new Set(["/usr/bin/systemctl"]);
  state.json = "[]";
  state.table = "";
  state.offset = "+0000\n";
  state.show = "";
  state.updates = {
    auto: false,
    channel: "stable",
    hour: 3,
    nightlyTiming: "hour",
    method: "github",
  };
  state.routes = [];
  state.network = null;
});
afterEach(() => vi.useRealTimers());

describe("scheduleAvailable", () => {
  it.each(["/usr/bin/systemctl", "/bin/systemctl", "/usr/local/bin/systemctl"])("is available with %s", (p) => {
    state.existing = new Set([p]);
    expect(scheduleAvailable()).toEqual({ available: true, reason: null });
  });

  it("explains itself without systemd and runs nothing", async () => {
    state.existing = new Set(["/usr/sbin/cron"]);
    const r = scheduleAvailable();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/systemd/i);
    const data = await scheduleData();
    expect(data).toEqual({ available: false, reason: r.reason });
    expect(host).not.toHaveBeenCalled();
  });
});

describe("timers from JSON (systemd >= 250)", () => {
  it("converts microseconds, names timers, maps results and sorts with unscheduled last", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    state.json = JSON.stringify([
      {
        unit: "logrotate.timer",
        activates: "logrotate.service",
        next: us("2026-11-09T00:00:00Z") + 123_600,
        last: us("2026-11-08T00:00:01Z"),
      },
      {
        unit: "nightly-sync.timer",
        activates: "nightly-sync.service",
        next: us("2026-11-08T23:30:00Z"),
        last: us("2026-11-07T23:30:00Z"),
      },
      {
        unit: "foo-report.timer",
        activates: "foo-report.service",
        next: 0,
        last: us("2026-11-08T06:10:00Z"),
      },
      { unit: "idle.timer", activates: "idle.service", next: null, last: -1 },
      {
        unit: "custom@x.timer",
        activates: "custom@x.service",
        next: us("2026-11-08T13:00:00Z"),
      },
      { activates: "orphan.service", next: us("2026-11-08T13:00:00Z") },
      {
        unit: 42,
        activates: "weird.service",
        next: us("2026-11-08T13:00:00Z"),
      },
    ]);
    state.show = [
      block("logrotate.timer", "Daily rotation of log files"),
      block("logrotate.service", "Rotate log files", "success"),
      block("nightly-sync.timer", "Timer for nightly sync"),
      block("nightly-sync.service", "Run nightly thing.", "exit-code"),
      block("foo-report.timer", "timer for foo report"),
      block("foo-report.service", "", "timeout"),
      block("custom@x.timer", ""),
      block("custom@x.service", "", "success"),
    ].join("\n\n");

    const list = await items();
    expect(list.map((i) => i.id)).toEqual([
      "timer:custom@x.timer",
      "timer:nightly-sync.timer",
      "timer:logrotate.timer",
      "timer:foo-report.timer",
    ]);
    const [custom, sync, logrotate, report] = list;
    expect(logrotate).toEqual({
      id: "timer:logrotate.timer",
      name: "Tidy up log files",
      unit: "logrotate.timer",
      next: Date.parse("2026-11-09T00:00:00Z") + 124,
      last: Date.parse("2026-11-08T00:00:01Z"),
      lastResult: "success",
      source: "system",
      approx: false,
      detail: null,
    });
    expect(sync).toMatchObject({ name: "Nightly thing", lastResult: "failed" });
    expect(report).toMatchObject({
      name: "Foo report",
      next: null,
      lastResult: "failed",
    });
    // No last run, so systemd's "success" is not a result for anything.
    expect(custom).toMatchObject({
      name: "custom",
      last: null,
      lastResult: null,
    });
  });

  it.each([
    ["apt-daily.timer", "Check for system updates"],
    ["apt-daily-upgrade.timer", "Install security updates"],
    ["fstrim.timer", "Trim SSDs"],
    ["e2scrub_all.timer", "Check disks for errors"],
    ["man-db.timer", "Rebuild the manual index"],
    ["systemd-tmpfiles-clean.timer", "Clear old temporary files"],
    ["certbot.timer", "Renew certificates"],
    ["certbot-renew@example.com.timer", "Renew certificates"],
    ["restic-backup@home.timer", "Back up"],
    ["borgmatic.timer", "Back up"],
    ["Backup-Nightly.timer", "Back up"],
    ["zfs-scrub-monthly@tank.timer", "Check ZFS pools for errors"],
    ["fwupd-refresh.timer", "Check for firmware updates"],
  ])("calls %s %j even when systemd describes it", async (unit, name) => {
    state.json = JSON.stringify([
      {
        unit,
        activates: unit.replace(/\.timer$/, ".service"),
        next: us("2026-11-09T00:00:00Z"),
      },
    ]);
    state.show = [
      block(unit, "Run something else entirely."),
      block(unit.replace(/\.timer$/, ".service"), "Trigger for other"),
    ].join("\n\n");
    expect((await items())[0].name).toBe(name);
  });

  it.each([
    ["Run nightly thing.", "", "Nightly thing"],
    ["", "Timer for foo sync", "Foo sync"],
    ["TRIGGER FOR photo import.", "Timer for ignored", "Photo import"],
    ["trigger weekly digest", "", "Weekly digest"],
    ["", "", "media-index"],
  ])("names from service %j / timer %j as %j", async (svc, timer, name) => {
    state.json = JSON.stringify([
      {
        unit: "media-index.timer",
        activates: "media-index.service",
        next: us("2026-11-09T00:00:00Z"),
      },
    ]);
    state.show = [block("media-index.timer", timer), block("media-index.service", svc)].join("\n\n");
    expect((await items())[0].name).toBe(name);
  });

  it("keeps items with default names when systemctl show fails", async () => {
    state.json = JSON.stringify([
      {
        unit: "logrotate.timer",
        activates: "logrotate.service",
        next: us("2026-11-09T00:00:00Z"),
        last: us("2026-11-08T00:00:00Z"),
      },
      {
        unit: "mystery@a.timer",
        activates: "mystery@a.service",
        next: us("2026-11-10T00:00:00Z"),
        last: us("2026-11-08T00:00:00Z"),
      },
    ]);
    state.show = null;
    expect((await items()).map((i) => [i.name, i.lastResult])).toEqual([
      ["Tidy up log files", null],
      ["mystery", null],
    ]);
  });
});

describe("timers from the plain table (old systemd)", () => {
  const TABLE = [
    "Tue 2026-09-29 00:00:00 CDT 5h left       Mon 2026-09-28 00:00:01 CDT 18h ago      logrotate.timer              logrotate.service",
    "n/a                         n/a           Mon 2026-09-28 06:10:00 CDT 12h ago      foo-backup.timer             foo-backup.service",
    "n/a n/a n/a n/a never.timer never.service",
    "",
    "Wed 2026-09-30 03:00:00 CDT 1 day left    -                           -            custom@x.timer               custom@x.service",
    "4 timers listed.",
  ].join("\n");

  it("reads host wall-clock times using the date +%z offset", async () => {
    state.json = null;
    state.table = TABLE;
    state.offset = "-0500\n";
    const all = await byId();
    expect(Object.keys(all).sort()).toEqual([
      "timer:custom@x.timer",
      "timer:foo-backup.timer",
      "timer:logrotate.timer",
    ]);
    expect(all["timer:logrotate.timer"]).toMatchObject({
      next: Date.parse("2026-09-29T05:00:00Z"),
      last: Date.parse("2026-09-28T05:00:01Z"),
    });
    expect(all["timer:foo-backup.timer"]).toMatchObject({
      next: null,
      last: Date.parse("2026-09-28T11:10:00Z"),
      name: "foo-backup",
    });
    expect(all["timer:custom@x.timer"]).toMatchObject({
      next: Date.parse("2026-09-30T08:00:00Z"),
      last: null,
    });
    expect((await items()).map((i) => i.id).at(-1)).toBe("timer:foo-backup.timer");
    expect(host).toHaveBeenCalledWith(
      "systemctl",
      ["list-timers", "--all", "--no-pager", "--no-legend"],
      expect.anything(),
    );
  });

  it("falls back to the table when JSON output is not JSON, and assumes UTC when date fails", async () => {
    state.json = "NEXT LEFT LAST PASSED UNIT ACTIVATES";
    state.table = TABLE;
    state.offset = null;
    const all = await byId();
    expect(all["timer:logrotate.timer"].next).toBe(Date.parse("2026-09-29T00:00:00Z"));
  });

  it("handles a positive offset", async () => {
    state.json = null;
    state.table =
      "Tue 2026-09-29 00:00:00 IST 5h left Mon 2026-09-28 00:00:01 IST 18h ago logrotate.timer logrotate.service";
    state.offset = "+0530\n";
    expect((await items())[0].next).toBe(Date.parse("2026-09-28T18:30:00Z"));
  });
});

describe("Gluon's update window", () => {
  const at = (d: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d);
  };
  const gluon = async () => (await items()).find((i) => i.source === "gluon");

  it("schedules today's hour while it is still ahead", async () => {
    at(new Date(2026, 10, 8, 2, 30));
    state.updates = {
      auto: true,
      channel: "stable",
      hour: 3,
      nightlyTiming: "asap",
      method: "github",
    };
    expect(await gluon()).toMatchObject({
      id: "gluon:update",
      name: expect.any(String),
      unit: null,
      next: new Date(2026, 10, 8, 3).getTime(),
      last: null,
      lastResult: null,
      source: "gluon",
      approx: true,
    });
  });

  it.each([
    ["already past", new Date(2026, 10, 8, 4, 0), 3, new Date(2026, 10, 9, 3).getTime()],
    ["exactly on the hour", new Date(2026, 10, 8, 3, 0, 0), 3, new Date(2026, 10, 9, 3).getTime()],
    ["midnight from late evening", new Date(2026, 11, 31, 23, 59), 0, new Date(2027, 0, 1, 0).getTime()],
  ])("moves to tomorrow when %s", async (_, now, hour, next) => {
    at(now);
    state.updates = {
      auto: true,
      channel: "nightly",
      hour,
      nightlyTiming: "hour",
      method: "github",
    };
    expect((await gluon())?.next).toBe(next);
  });

  it.each([
    [{ auto: false, channel: "stable", nightlyTiming: "hour" }],
    [{ auto: true, channel: "nightly", nightlyTiming: "asap" }],
  ])("is absent for %j", async (u) => {
    state.updates = { hour: 3, method: "github", ...u };
    expect(await gluon()).toBeUndefined();
  });
});

describe("certificate renewals", () => {
  const route = (host: string, validFrom: string, validTo: string, extra: Record<string, unknown> = {}) => ({
    host,
    enabled: true,
    tls: { status: "ok", validFrom, validTo },
    ...extra,
  });
  const certs = async () => (await items()).filter((i) => i.source === "certificate");

  it("renews with a third of the lifetime left, one item per host, never in the past", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    state.routes = [
      route("cloud.example.com", "2026-11-01T00:00:00Z", "2027-01-30T00:00:00Z"),
      route("cloud.example.com", "2026-10-01T00:00:00Z", "2026-12-30T00:00:00Z"),
      {
        host: "old.example.com",
        enabled: true,
        tls: {
          status: "expiring",
          validFrom: "2026-08-15T00:00:00Z",
          validTo: "2026-11-13T00:00:00Z",
        },
      },
      route("off.example.com", "2026-11-01T00:00:00Z", "2027-01-30T00:00:00Z", {
        enabled: false,
      }),
      route("plain.example.com", "", "", { tls: null }),
      {
        host: "dead.example.com",
        enabled: true,
        tls: {
          status: "expired",
          validFrom: "2026-01-01T00:00:00Z",
          validTo: "2026-04-01T00:00:00Z",
        },
      },
      {
        host: "err.example.com",
        enabled: true,
        tls: {
          status: "error",
          validFrom: "2026-11-01T00:00:00Z",
          validTo: "2027-01-30T00:00:00Z",
        },
      },
      {
        host: "junk.example.com",
        enabled: true,
        tls: {
          status: "ok",
          validFrom: "not a date",
          validTo: "2027-01-30T00:00:00Z",
        },
      },
    ];
    const list = await certs();
    expect(list.map((c) => [c.id, c.next])).toEqual([
      ["cert:old.example.com", Date.parse("2026-11-08T12:00:00Z")],
      ["cert:cloud.example.com", Date.parse("2026-11-30T00:00:00Z")],
    ]);
    expect(list[1]).toMatchObject({
      name: "Renew a certificate",
      detail: "cloud.example.com",
      approx: true,
      source: "certificate",
    });
  });

  it("matches the spec's 90-day example", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    state.routes = [route("photos.example.com", "2026-11-01T00:00:00Z", "2027-01-30T00:00:00Z")];
    expect((await certs())[0].next).toBe(Date.parse("2026-12-31T00:00:00Z"));
  });

  it("shows no certificates when network status fails", async () => {
    state.json = JSON.stringify([
      {
        unit: "fstrim.timer",
        activates: "fstrim.service",
        next: us("2026-11-09T00:00:00Z"),
      },
    ]);
    state.network = async () => {
      throw new Error("caddy unreachable");
    };
    const list = await items();
    expect(list.map((i) => i.id)).toEqual(["timer:fstrim.timer"]);
  });

  it("gives up on certificates when network status is too slow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    const late = route("slow.example.com", "2026-11-01T00:00:00Z", "2027-01-30T00:00:00Z");
    state.network = () => new Promise((resolve) => setTimeout(() => resolve({ routes: [late] }), 8_000));
    const pending = scheduleData();
    await vi.advanceTimersByTimeAsync(10_000);
    const data = await pending;
    expect(data.available && data.items.filter((i) => i.source === "certificate")).toEqual([]);
  });
});
