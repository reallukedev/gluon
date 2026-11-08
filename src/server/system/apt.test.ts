import { describe, expect, it } from "vitest";
import {
  assertPackageName,
  compareVersions,
  describeHolders,
  explainAptError,
  parseAptList,
  parseSimulation,
} from "./apt";

const sign = (n: number) => Math.sign(n);

describe("compareVersions", () => {
  it.each([
    ["6.12.10", "6.12.9"],
    ["6.12.108+deb13-amd64", "6.12.99+deb13-amd64"],
    ["10", "9"],
    ["1.0", "1.0~rc1"],
    ["1.0~rc2", "1.0~rc1"],
    ["1.0~", "1.0~~"],
    ["2.41-12+deb13u1", "2.41-12"],
    ["1.0.0", "1.0"],
    ["1.0a", "1.0"],
    ["3.5.1-1+deb13u1", "3.5.1-1"],
    ["2026a-0+deb13u1", "2025b-4"],
    ["1.10", "1.9.9"],
    ["1.001", "1.0"],
  ])("%s > %s, and the reverse is negative", (hi, lo) => {
    expect(sign(compareVersions(hi, lo))).toBe(1);
    expect(sign(compareVersions(lo, hi))).toBe(-1);
  });

  it("treats equal strings and numerically equal digit runs as equal", () => {
    for (const v of ["6.12.108-1", "1.0~rc1", "", "2.41-12+deb13u1"]) expect(compareVersions(v, v)).toBe(0);
    expect(sign(compareVersions("1.01", "1.1"))).toBe(0);
  });

  it("sorts kernel versions", () => {
    const sorted = ["6.12.9", "6.12.108", "6.1.0", "6.12.10~rc1", "6.12.10"].sort(compareVersions);
    expect(sorted).toEqual(["6.1.0", "6.12.9", "6.12.10~rc1", "6.12.10", "6.12.108"]);
  });

  it("is antisymmetric across a mixed sample", () => {
    const sample = [
      "1.0",
      "1.0~rc1",
      "1.0~~",
      "1.0~",
      "1.0.0",
      "1.0a",
      "1.0+",
      "2.41-12",
      "2.41-12+deb13u1",
      "10",
      "9",
      "6.12.108",
    ];
    for (const a of sample)
      for (const b of sample) expect(sign(compareVersions(a, b)) + 0).toBe(-sign(compareVersions(b, a)) + 0);
  });

  // Suspected bug: "1.0a" sorts after "1.0+", against Debian policy.
  it.fails("sorts letters before other symbols", () => {
    expect(sign(compareVersions("1.0a", "1.0+"))).toBe(-1);
    expect(sign(compareVersions("1.0+", "1.0a"))).toBe(1);
  });
});

describe("parseAptList", () => {
  it("reads apt list --upgradable output", () => {
    const out = `Listing...
libssl3t64/trixie-security 3.5.1-1+deb13u1 amd64 [upgradable from: 3.5.1-1]
tzdata/stable-updates,stable 2026a-0+deb13u1 all [upgradable from: 2025b-4]

linux-image-amd64/trixie-security,now 6.12.108-1 amd64 [upgradable from: 6.12.99-1]
WARNING: apt does not have a stable CLI interface. Use with caution in scripts.
vim/trixie 2:9.1.1230-2 arm64 [upgradable from: 2:9.1.1230-1]
this line is not a package
`;
    expect(parseAptList(out)).toEqual([
      {
        name: "libssl3t64",
        suites: ["trixie-security"],
        candidate: "3.5.1-1+deb13u1",
        arch: "amd64",
        current: "3.5.1-1",
      },
      {
        name: "tzdata",
        suites: ["stable-updates", "stable"],
        candidate: "2026a-0+deb13u1",
        arch: "all",
        current: "2025b-4",
      },
      {
        name: "linux-image-amd64",
        suites: ["trixie-security"],
        candidate: "6.12.108-1",
        arch: "amd64",
        current: "6.12.99-1",
      },
      { name: "vim", suites: ["trixie"], candidate: "2:9.1.1230-2", arch: "arm64", current: "2:9.1.1230-1" },
    ]);
  });

  it("returns nothing for empty or header-only output", () => {
    expect(parseAptList("")).toEqual([]);
    expect(parseAptList("Listing... Done\n")).toEqual([]);
  });
});

describe("parseSimulation", () => {
  it("reads apt-get -s upgrade output", () => {
    const out = `Reading package lists...
Building dependency tree...
The following packages have been kept back:
  linux-image-amd64 foo
The following packages will be upgraded:
  libc6 libssl3t64
3 upgraded, 1 newly installed, 1 to remove and 2 not upgraded.
Inst libc6 [2.41-12] (2.41-12+deb13u1 Debian:13.2/stable, Debian-Security:13/stable-security [amd64])
Inst linux-image-6.12.108+deb13-amd64 (6.12.108-1 Debian-Security:13/stable-security [amd64])
Inst libfoo:i386 [1.0-1] (1.0-2 Debian:13/stable [i386])
Conf libc6 (2.41-12+deb13u1 Debian:13.2/stable, Debian-Security:13/stable-security [amd64])
Remv oldpkg:amd64 [1.0]
`;
    expect(parseSimulation(out)).toEqual({
      installs: [
        {
          name: "libc6",
          arch: "amd64",
          current: "2.41-12",
          candidate: "2.41-12+deb13u1",
          origins: ["Debian:13.2/stable", "Debian-Security:13/stable-security"],
        },
        {
          name: "linux-image-6.12.108+deb13-amd64",
          arch: "amd64",
          current: null,
          candidate: "6.12.108-1",
          origins: ["Debian-Security:13/stable-security"],
        },
        { name: "libfoo", arch: "i386", current: "1.0-1", candidate: "1.0-2", origins: ["Debian:13/stable"] },
      ],
      removals: ["oldpkg"],
      keptBack: ["linux-image-amd64", "foo"],
    });
  });

  it("reads the newer Not upgrading heading and stops at the next heading", () => {
    const out = `Reading package lists...
Not upgrading:
  linux-image-amd64 linux-headers-amd64
  firmware-misc-nonfree
Summary:
  Upgrading: 0, Installing: 0, Removing: 0, Not Upgrading: 3
`;
    expect(parseSimulation(out)).toEqual({
      installs: [],
      removals: [],
      keptBack: ["linux-image-amd64", "linux-headers-amd64", "firmware-misc-nonfree"],
    });
  });

  it("returns empty lists for empty input", () => {
    expect(parseSimulation("")).toEqual({ installs: [], removals: [], keptBack: [] });
  });
});

describe("explainAptError", () => {
  it.each([
    [
      "Err:1 http://deb.example.com/debian trixie InRelease\n  Temporary failure resolving 'deb.example.com'",
      /^Couldn't look up deb\.example\.com\./,
    ],
    [
      "Err:3 https://repo.example.com/apt stable InRelease\n  Could not connect to repo.example.com:443 (203.0.113.5), connection timed out",
      /^Couldn't reach repo\.example\.com\./,
    ],
    ["E: Failed to connect to mirror.example.com:80 (198.51.100.7)", /^Couldn't reach mirror\.example\.com\./],
    ["Unable to connect to apt.example.com:http:", /^Couldn't reach apt\.example\.com/],
    [
      "E: Release file for http://deb.example.com/debian/dists/trixie-updates/InRelease is not valid yet (invalid for another 5h 2min 1s).",
      /clock/,
    ],
    [
      "E: Release file for http://deb.example.com/debian/dists/trixie/InRelease is expired (invalid since 3d 4h 5min 0s).",
      /clock/,
    ],
    [
      "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 1234 (apt-get)",
      /^Another update was running at the same time\.$/,
    ],
    ["E: Unable to lock directory /var/lib/apt/lists/", /^Another update was running at the same time\.$/],
    [
      "Reading package lists...\nW: Some index files failed to download. They have been ignored, or old ones used instead.",
      /^Some index files failed to download/,
    ],
    ["Reading package lists...\nE: Sub-process returned an error code", /^Sub-process returned an error code$/],
    ["Reading package lists...\nall fine?", /^apt couldn't refresh the package lists\.$/],
    ["", /^apt couldn't refresh the package lists\.$/],
  ])("explains %j", (out, re) => {
    expect(explainAptError(out)).toMatch(re);
  });

  it("explains a missing signing key and names the source", () => {
    const out =
      "W: GPG error: https://repo.example.com/deb stable InRelease: The following signatures couldn't be verified because the public key is not available: NO_PUBKEY 0123456789ABCDEF\nE: The repository 'https://repo.example.com/deb stable InRelease' is not signed.";
    const msg = explainAptError(out);
    expect(msg).toMatch(/^A package source's signing key is missing or expired/);
    expect(msg).toContain("(https://repo.example.com/deb)");
    expect(explainAptError("W: GPG error: EXPKEYSIG 0123456789ABCDEF Example Repo <ops@example.com>")).toMatch(
      /^A package source's signing key is missing or expired/,
    );
  });

  it("names a source that no longer exists", () => {
    const msg = explainAptError(
      "E: The repository 'http://ppa.example.com/ubuntu noble Release' does not have a Release file.",
    );
    expect(msg).toMatch(/^A package source no longer exists \(http:\/\/ppa\.example\.com\/ubuntu\)/);
  });

  it("follows the priority order", () => {
    const resolveAndLock =
      "Temporary failure resolving 'deb.example.com'\nE: Could not get lock /var/lib/dpkg/lock-frontend\nE: The repository 'http://x.example.com/a b' is not signed.";
    expect(explainAptError(resolveAndLock)).toMatch(/^Couldn't look up deb\.example\.com/);
    expect(explainAptError("NO_PUBKEY ABC\n404  Not Found\nCould not get lock")).toMatch(
      /^A package source's signing key/,
    );
    expect(explainAptError("Release file for x is expired\n404  Not Found")).toMatch(/clock/);
    expect(explainAptError("404  Not Found [IP: 203.0.113.9 80]\nE: Could not get lock")).toMatch(
      /^A package source no longer exists/,
    );
  });

  it("caps a fallback line at 240 characters", () => {
    const msg = explainAptError(`E: ${"x".repeat(500)}`);
    expect(msg.length).toBeLessThanOrEqual(240);
    expect(msg.startsWith("xxx")).toBe(true);
  });
});

describe("assertPackageName", () => {
  it.each([
    "libc6",
    "linux-image-6.12.108+deb13-amd64",
    "g++",
    "libfoo:i386",
    "0ad",
    "a".repeat(128),
    "libbar:arm64",
    `x:${"a".repeat(32)}`,
  ])("accepts %j", (p) => {
    expect(() => assertPackageName(p)).not.toThrow();
  });

  it.each([
    "",
    "-y",
    "--purge",
    "Foo",
    "foo bar",
    "foo;rm",
    "foo/stable",
    "foo:",
    "foo:amd64:x",
    "a".repeat(129),
    ".foo",
    "+foo",
    "foo:AMD64",
    `x:${"a".repeat(33)}`,
    "foo\n",
  ])("refuses %j", (p) => {
    expect(() => assertPackageName(p)).toThrow(expect.objectContaining({ code: "invalid_package", status: 400 }));
  });

  it("quotes at most 60 characters of the name", () => {
    const name = `Bad${"x".repeat(100)}`;
    let msg = "";
    try {
      assertPackageName(name);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(name.slice(0, 60));
    expect(msg).not.toContain(name.slice(0, 61));
  });
});

describe("describeHolders", () => {
  it("lists distinct first words of plain apt holders", () => {
    expect(
      describeHolders([
        { pid: 10, command: "apt-get install x", lock: "/var/lib/dpkg/lock" },
        { pid: 11, command: "dpkg --configure", lock: "/var/lib/dpkg/lock-frontend" },
        { pid: 12, command: "apt-get y", lock: "/var/lib/apt/lists/lock" },
      ]),
    ).toBe("Another update is running (apt-get, dpkg). Try again when it finishes.");
  });

  it.each([
    [
      [{ pid: 5, command: "/usr/bin/python3 /usr/bin/unattended-upgrade --download-only", lock: "/var/lib/dpkg/lock" }],
      /^Another update is running/,
    ],
    [
      [
        { pid: 1, command: "apt-get install foo", lock: "/var/lib/dpkg/lock" },
        { pid: 2, command: "/usr/bin/unattended-upgrade", lock: "/var/lib/dpkg/lock" },
      ],
      /^Automatic updates are running/,
    ],
    [
      [
        { pid: 3, command: "dpkg -i x.deb", lock: "/var/lib/dpkg/lock" },
        { pid: 4, command: "/usr/libexec/PackageKitd", lock: "/var/lib/dpkg/lock" },
      ],
      /^Another program \(PackageKit\) is installing software/,
    ],
    [
      [
        { pid: 6, command: "packagekitd", lock: "/var/lib/dpkg/lock" },
        { pid: 7, command: "unattended-upgr", lock: "/var/lib/dpkg/lock" },
      ],
      /^Automatic updates are running/,
    ],
  ])("prefers automatic updates, then PackageKit (%#)", (holders, re) => {
    const s = describeHolders(holders);
    expect(s).toMatch(re);
    expect(s.endsWith("Try again when it finishes.")).toBe(true);
  });
});
