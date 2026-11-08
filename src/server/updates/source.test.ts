import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTarget, RunningBuild } from "@/lib/updates-types";

vi.mock("@/server/docker/client", () => ({ docker: () => ({}) }));

const { compareVersions, isNewer, nightlyVersion, relate, runningBuild, sameCommit } = await import("./source");

const target = (version: string, commit: string, channel: "stable" | "nightly" = "stable"): GithubTarget => ({
  channel,
  ref: channel === "stable" ? `v${version}` : commit,
  version,
  commit,
  title: `Gluon ${version}`,
  notes: "",
  url: "https://github.example.com/gluon/releases",
  publishedAt: Date.UTC(2026, 9, 1),
  since: null,
});
const running = (version: string, commit: string | null, channel: "stable" | "nightly" = "stable"): RunningBuild => ({
  version,
  commit,
  build: null,
  channel,
  startedAt: Date.UTC(2026, 10, 1),
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("compareVersions", () => {
  it.each([
    ["1.10.0", "1.9.2"],
    ["2.0.0", "1.99.99"],
    ["1.2.0", "1.2.0-nightly.20260928.abc1234"],
    ["1.2.0", "1.2.0-rc.1"],
    ["1.3.0-nightly.20261001.0000000", "1.3.0-nightly.20260928.aaaaaaa"],
    ["1.0.0-rc.10", "1.0.0-rc.2"],
    ["1.0.0-alpha", "1.0.0-1"],
    ["1.0.0-alpha.1", "1.0.0-alpha"],
    ["1.3.0-nightly.20260101.0000000", "1.2.9"],
    ["v1.2.1", " 1.2.0 "],
    ["1.0.0-beta", "1.0.0-alpha.9"],
  ])("%j > %j", (hi, lo) => {
    expect(compareVersions(hi, lo)).toBe(1);
    expect(compareVersions(lo, hi)).toBe(-1);
  });

  it.each([
    ["1.2", "1.2.0"],
    ["v1.2.0", "1.2.0"],
    ["  1.2.0\n", "1.2.0"],
    ["1.0.0+b1", "1.0.0+b2"],
    ["1.3.0-nightly.20260928.1a2b3c4", "v1.3.0-nightly.20260928.1a2b3c4"],
    ["x.y.z", "0.0.0"],
    ["", "0.0.0"],
  ])("%j == %j", (a, b) => {
    expect(compareVersions(a, b)).toBe(0);
  });

  it("never throws on junk", () => {
    for (const [a, b] of [
      ["-", "+"],
      ["1..2", "1.2"],
      ["...", "v"],
      ["1.0.0-", "1.0.0"],
      ["🦄", "1"],
    ]) {
      expect([-1, 0, 1]).toContain(compareVersions(a, b));
    }
  });
});

describe("sameCommit", () => {
  it.each<[string | null, string | null, boolean]>([
    ["abc1234", "abc1234def5678", true],
    ["abc1234def5678", "abc1234", true],
    ["abc1234def", "abc1234fff", false],
    ["abc123", "abc123", false],
    ["abc1234", "abc1235", false],
    [null, "abc1234", false],
    ["abc1234", null, false],
    ["", "", false],
    ["", "abc1234", false],
    [`${"a".repeat(40)}`, `${"a".repeat(40)}ffff`, true],
    [`${"a".repeat(40)}0`, `${"a".repeat(40)}1`, true],
  ])("sameCommit(%j, %j) = %s", (a, b, out) => {
    expect(sameCommit(a, b)).toBe(out);
  });
});

describe("nightlyVersion", () => {
  it("builds base-nightly.UTC date.short sha", () => {
    expect(nightlyVersion("1.2.3", Date.UTC(2026, 8, 28, 23, 0), "1a2b3c4d5e6f")).toBe(
      "1.2.3-nightly.20260928.1a2b3c4",
    );
    expect(nightlyVersion("1.2.3", Date.UTC(2026, 8, 28, 23, 30), "1a2b3c4d5e6f")).toBe(
      "1.2.3-nightly.20260928.1a2b3c4",
    );
    expect(nightlyVersion("10.20.30", Date.UTC(2027, 0, 1, 0, 0, 1), "ffffffffffff")).toBe(
      "10.20.30-nightly.20270101.fffffff",
    );
  });

  it.each([null, "1.2", "1.2.3-rc.1", "v1.2.3", "", "1.2.3.4", "a.b.c"])("replaces base %j with 0.0.0", (base) => {
    expect(nightlyVersion(base, Date.UTC(2026, 8, 28), "1a2b3c4d")).toBe("0.0.0-nightly.20260928.1a2b3c4");
  });

  it("keeps the name a valid Docker tag", () => {
    const t = Date.UTC(2026, 8, 28);
    const long = nightlyVersion(`${"1".repeat(50)}.0.0`, t, "1a2b3c4d");
    expect(long.startsWith("0.0.0-nightly.")).toBe(true);
    for (const v of [
      long,
      nightlyVersion("1.2.3", t, "abc"),
      nightlyVersion(`${"9".repeat(30)}.1.1`, t, "deadbeefcafe"),
    ]) {
      expect(v).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
    expect(nightlyVersion(null, Date.UTC(2026, 0, 5), "abc")).toBe("0.0.0-nightly.20260105.abc");
  });

  it("keeps a base that fits exactly", () => {
    // "-nightly.20260928.1a2b3c4" is 25 characters, leaving 39 for the base.
    const base = `${"1".repeat(35)}.0.0`;
    expect(base).toHaveLength(39);
    expect(nightlyVersion(base, Date.UTC(2026, 8, 28), "1a2b3c4d")).toBe(`${base}-nightly.20260928.1a2b3c4`);
    expect(nightlyVersion(`1${base}`, Date.UTC(2026, 8, 28), "1a2b3c4d").startsWith("0.0.0-")).toBe(true);
  });
});

describe("isNewer", () => {
  it("compares commits on nightly and versions on stable", () => {
    expect(
      isNewer(
        target("1.3.0-nightly.20261001.fff0000", "fff0000aaa", "nightly"),
        running("1.3.0-nightly.20260928.abc1234", "abc1234def", "nightly"),
        "nightly",
      ),
    ).toBe(true);
    expect(
      isNewer(
        target("1.3.0-nightly.20261001.abc1234", "abc1234def0", "nightly"),
        running("whatever", "abc1234", "nightly"),
        "nightly",
      ),
    ).toBe(false);
    expect(isNewer(target("1.0.0", "abc1234def", "nightly"), running("1.2.0", null), "nightly")).toBe(true);
    expect(isNewer(target("1.3.0", "fff0000"), running("1.2.0", "abc1234def"), "stable")).toBe(true);
    expect(isNewer(target("1.2.0", "fff0000"), running("1.2.0", "abc1234def"), "stable")).toBe(false);
    expect(isNewer(target("1.2.0", "fff0000"), running("1.2.0-rc.3", "abc1234def"), "stable")).toBe(true);
    expect(isNewer(target("1.1.9", "fff0000"), running("1.2.0", "abc1234def"), "stable")).toBe(false);
  });
});

describe("relate", () => {
  const r = running("1.2.0", "abc1234def", "stable");

  it.each([
    ["1.3.0", "fff0000", "newer"],
    ["1.1.0", "fff0000", "ahead"],
    ["1.2.0", "fff0000", "current"],
    ["1.0.0", "abc1234", "current"],
    ["v1.2.0", "fff0000", "current"],
  ])("stable target %s/%s is %s", async (version, commit, relation) => {
    await expect(relate(target(version, commit), r, "stable")).resolves.toEqual({ relation, certain: true });
  });

  it("calls a higher release newer for a local build with no commit", async () => {
    await expect(relate(target("1.3.0", "fff0000"), running("1.2.0", null), "stable")).resolves.toEqual({
      relation: "newer",
      certain: true,
    });
  });

  it("goes by commit alone on nightly", async () => {
    const nightly = running("1.3.0-nightly.20260928.abc1234", "abc1234def", "nightly");
    await expect(relate(target("1.0.0", "abc1234def99", "nightly"), nightly, "nightly")).resolves.toEqual({
      relation: "current",
      certain: true,
    });
    await expect(relate(target("9.9.9", "fff0000", "nightly"), nightly, "nightly")).resolves.toEqual({
      relation: "newer",
      certain: true,
    });
    await expect(relate(target("0.0.1", "fff0000", "nightly"), nightly, "nightly")).resolves.toEqual({
      relation: "newer",
      certain: true,
    });
  });

  it("is unsure when GitHub can't tell whether a nightly already has the release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    const nightly = running("1.2.0-nightly.20260928.abc1234", "abc1234def", "nightly");
    await expect(relate(target("1.3.0", "fff0000"), nightly, "stable")).resolves.toEqual({
      relation: "newer",
      certain: false,
    });
  });
});

describe("runningBuild", () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version as string;

  it("reads the build from the environment", () => {
    vi.stubEnv("GLUON_VERSION", "  1.3.0-nightly.20260928.1a2b3c4 ");
    vi.stubEnv("GLUON_COMMIT", " 1a2b3c4d5e ");
    vi.stubEnv("GLUON_BUILD", " 4711 ");
    expect(runningBuild()).toMatchObject({
      version: "1.3.0-nightly.20260928.1a2b3c4",
      commit: "1a2b3c4d5e",
      build: "4711",
      channel: "nightly",
    });
  });

  it.each([
    ["1.2.0", "stable"],
    ["main-1a2b3c4", "nightly"],
    ["1.2.0-rc.1", "stable"],
  ])("judges %s as %s", (version, channel) => {
    vi.stubEnv("GLUON_VERSION", version);
    expect(runningBuild().channel).toBe(channel);
  });

  it.each(["ABC1234", "xyz", "", "abc12", "a".repeat(41), "abc1234 extra"])("drops commit %j", (commit) => {
    vi.stubEnv("GLUON_COMMIT", commit);
    expect(runningBuild().commit).toBeNull();
  });

  it("falls back to package.json and keeps a fixed start time", () => {
    vi.stubEnv("GLUON_VERSION", undefined);
    vi.stubEnv("GLUON_COMMIT", undefined);
    vi.stubEnv("GLUON_BUILD", undefined);
    const a = runningBuild();
    expect(a.version).toBe(pkgVersion);
    expect(a.version).toMatch(/\S/);
    expect(a.commit).toBeNull();
    expect(a.build).toBeNull();
    expect(typeof a.startedAt).toBe("number");
    expect(runningBuild().startedAt).toBe(a.startedAt);
    expect(runningBuild().commit).toBeNull();
    vi.stubEnv("GLUON_COMMIT", "a".repeat(40));
    expect(runningBuild().commit).toBe("a".repeat(40));
  });
});
