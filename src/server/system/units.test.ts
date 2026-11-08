import { describe, expect, it } from "vitest";
import {
  type Policy,
  aboutUnit,
  blockedReason,
  friendlyName,
  isImportant,
  isValidUnit,
  knownUnit,
  parseShow,
  parseUnit,
  policyFor,
  showList,
  showNumber,
  showTimestamp,
  takesGluonDown,
} from "./units";

const ALL = ["start", "stop", "restart", "reload", "enable", "disable"] as const;
const asSets = (p: Policy) => ({
  blocked: new Set(p.blocked),
  needsConfirm: new Set(p.needsConfirm),
  needsRecentAuth: new Set(p.needsRecentAuth),
});
const policy = (blocked: string[], needsConfirm: string[], needsRecentAuth: string[]) => ({
  blocked: new Set(blocked),
  needsConfirm: new Set(needsConfirm),
  needsRecentAuth: new Set(needsRecentAuth),
});

describe("isValidUnit", () => {
  it.each([
    "nginx.service",
    "wg-quick@wg0.service",
    "user@1000.service",
    "systemd-fsck@dev-disk-by\\x2duuid-1234.service",
    "getty@tty1.service",
    "NetworkManager.service",
    "foo:bar_baz.service",
    `${"a".repeat(248)}.service`,
  ])("accepts %j", (u) => {
    expect(isValidUnit(u)).toBe(true);
  });

  it.each<[unknown]>([
    [42],
    [null],
    [""],
    ["nginx"],
    ["nginx.socket"],
    ["foo.timer"],
    ["-x.service"],
    ["foo@.service"],
    ["a b.service"],
    ["a;rm -rf.service"],
    ["a/b.service"],
    ["\\xZZ.service"],
    ["a\\x2.service"],
    [`${"a".repeat(249)}.service`],
    ["nginx.service\n"],
    ["nginx.service "],
    ["ngïnx.service"],
    ["$(reboot).service"],
  ])("rejects %j", (u) => {
    expect(isValidUnit(u)).toBe(false);
  });
});

describe("parseUnit", () => {
  it.each([
    [" smbd ", "smbd.service"],
    ["docker", "docker.service"],
    ["nginx.service", "nginx.service"],
    ["wg-quick@wg0", "wg-quick@wg0.service"],
  ])("%j -> %j", (raw, out) => {
    expect(parseUnit(raw)).toBe(out);
  });

  it.each<[unknown]>([["foo.timer"], [""], ["   "], [null], [42], ["-rf"], ["a;b"], ["foo@"]])("refuses %j", (raw) => {
    expect(() => parseUnit(raw)).toThrow(expect.objectContaining({ code: "invalid_unit", status: 400 }));
  });
});

describe("names and importance", () => {
  it.each([
    "docker.service",
    "containerd.service",
    "ssh.service",
    "sshd.service",
    "smbd.service",
    "systemd-timesyncd.service",
    "cron.service",
    "networking.service",
    "NetworkManager.service",
    "systemd-resolved.service",
    "fail2ban.service",
    "tailscaled.service",
    "nfs-server.service",
    "casaos.service",
    "casaos-gateway.service",
    "wg-quick@wg0.service",
    "wg-quick@home-vpn.service",
  ])("treats %s as important", (u) => {
    expect(isImportant(u)).toBe(true);
    // The spec doesn't promise a curated name for patterned units (wg-quick@x gives "").
    expect(knownUnit(u)).toMatchObject({ important: true });
    expect(friendlyName(u)).toMatch(/\S/);
  });

  it.each(["winbind.service", "smartmontools.service", "udisks2.service", "rclone.service", "avahi-daemon.service"])(
    "knows %s without calling it important",
    (u) => {
      expect(knownUnit(u)).toMatchObject({ important: false, name: expect.stringMatching(/\S/) });
      expect(isImportant(u)).toBe(false);
    },
  );

  it("knows nothing about nginx", () => {
    expect(knownUnit("nginx.service")).toBeNull();
    expect(isImportant("nginx.service")).toBe(false);
  });

  it.each<[string, string | null | undefined, string]>([
    ["docker.service", "Docker Application Container Engine", "Docker"],
    ["ssh.service", "OpenBSD Secure Shell server", "Remote login (SSH)"],
    ["smbd.service", null, "Samba"],
    ["casaos-foo.service", "  CasaOS Foo  ", "CasaOS Foo"],
    ["x.service", "x.service", "x"],
    ["x.service", "  ", "x"],
    ["x.service", undefined, "x"],
    ["nginx.service", "A high performance web server", "A high performance web server"],
  ])("friendlyName(%j, %j) = %j", (u, d, out) => {
    expect(friendlyName(u, d)).toBe(out);
  });

  it("explains common services in plain words", () => {
    for (const u of [
      "docker.service",
      "ssh.service",
      "smbd.service",
      "cron.service",
      "getty@tty1.service",
      "wg-quick@wg0.service",
    ]) {
      expect(aboutUnit(u)).toMatch(/\S/);
    }
    expect(aboutUnit("docker.service")).toMatch(/Gluon/);
    expect(aboutUnit("nginx.service")).toBeNull();
  });
});

describe("policyFor", () => {
  it.each(["docker.service", "containerd.service"])("asks twice before taking everything down via %s", (u) => {
    expect(asSets(policyFor(u))).toEqual(
      policy([], ["stop", "restart", "disable"], ["stop", "disable", "restart", "enable"]),
    );
    expect(takesGluonDown(u)).toBe(true);
  });

  it.each([
    "dbus.service",
    "dbus-broker.service",
    "systemd-journald.service",
    "systemd-udevd.service",
    "systemd-logind.service",
    "polkit.service",
    "user@1000.service",
    "user-runtime-dir@1000.service",
    "getty@tty1.service",
    "serial-getty@ttyS0.service",
    "systemd-remount-fs.service",
    "systemd-fsck-root.service",
    "systemd-fsck@dev-disk-by\\x2duuid-1234.service",
    "systemd-tmpfiles-setup.service",
    "systemd-tmpfiles-setup-dev.service",
    "systemd-sysctl.service",
    "systemd-modules-load.service",
    "systemd-random-seed.service",
    "systemd-journal-flush.service",
    "systemd-user-sessions.service",
    "kmod-static-nodes.service",
    "ifupdown-pre.service",
    "console-setup.service",
    "keyboard-setup.service",
  ])("refuses to stop the system-critical %s", (u) => {
    expect(asSets(policyFor(u))).toEqual(policy(["stop", "restart", "disable"], [], ["enable"]));
  });

  it.each([
    "systemd-halt.service",
    "systemd-poweroff.service",
    "systemd-reboot.service",
    "systemd-kexec.service",
    "systemd-soft-reboot.service",
    "systemd-suspend.service",
    "systemd-hibernate.service",
    "systemd-hybrid-sleep.service",
    "systemd-suspend-then-hibernate.service",
    "emergency.service",
    "rescue.service",
    "halt.service",
    "poweroff.service",
    "reboot.service",
    "kexec.service",
    "gluon-apt-upgrade.service",
    "gluon-power-reboot.service",
  ])("blocks every action on %s", (u) => {
    expect(asSets(policyFor(u))).toEqual(policy([...ALL], [], []));
  });

  it("asks important services for recent auth on lasting or disruptive changes", () => {
    expect(asSets(policyFor("ssh.service"))).toEqual(policy([], [], ["stop", "disable", "enable"]));
    expect(asSets(policyFor("wg-quick@wg0.service"))).toEqual(policy([], [], ["stop", "disable", "enable"]));
    expect(asSets(policyFor("nginx.service"))).toEqual(policy([], [], ["enable"]));
  });

  it("never asks for recent auth on a blocked action", () => {
    for (const u of ["dbus.service", "reboot.service", "gluon-apt-x.service", "docker.service", "nginx.service"]) {
      const p = policyFor(u);
      expect(p.needsRecentAuth.filter((a) => p.blocked.includes(a))).toEqual([]);
    }
  });

  it.each(["docker.socket", "my-docker.service", "docker-compose.service", "containerd-shim.service"])(
    "does not think %s takes Gluon down",
    (u) => {
      expect(takesGluonDown(u)).toBe(false);
    },
  );
});

describe("blockedReason", () => {
  it("explains power, Gluon's own units and others", () => {
    expect(blockedReason("reboot.service", "start")).toMatch(/power/i);
    expect(blockedReason("systemd-suspend.service", "restart")).toMatch(/power/i);
    expect(blockedReason("gluon-apt-upgrade.service", "stop")).toMatch(/Gluon/);
    const dbus = blockedReason("dbus.service", "stop");
    expect(dbus).toContain("dbus");
    expect(dbus).toContain("stop");
    expect(dbus).not.toContain("dbus.service");
  });
});

describe("parseShow", () => {
  it("parses the sample into one record per block", () => {
    const out = parseShow("Id=a.service\nActiveState=active\nMainPID=1234\n\nId=b.service\nActiveState=failed\n");
    expect(out).toEqual([
      { Id: "a.service", ActiveState: "active", MainPID: "1234" },
      { Id: "b.service", ActiveState: "failed" },
    ]);
  });

  it("splits at the first = and skips junk lines and empty blocks", () => {
    const text = [
      "Id=x.service",
      "ExecStart={ path=/bin/x ; argv[]=/bin/x a=b ; ignore_errors=no }",
      "Empty=",
      "no equals sign here",
      "=orphan",
      "   \t ",
      "garbage",
      "=",
      "",
      "",
      "Id=y.service",
      "Description=Why = because",
    ].join("\n");
    expect(parseShow(text)).toEqual([
      { Id: "x.service", ExecStart: "{ path=/bin/x ; argv[]=/bin/x a=b ; ignore_errors=no }", Empty: "" },
      { Id: "y.service", Description: "Why = because" },
    ]);
    expect(parseShow("")).toEqual([]);
  });
});

describe("show values", () => {
  it.each<[string | undefined, number | null]>([
    ["1234", 1234],
    ["0", 0],
    [undefined, null],
    ["", null],
    ["[not set]", null],
    ["infinity", null],
    ["18446744073709551615", null],
    ["abc", null],
  ])("showNumber(%j) = %j", (v, out) => {
    expect(showNumber(v)).toBe(out);
  });

  it.each<[string | undefined, number | null]>([
    ["@1790375574", 1790375574000],
    ["@0", null],
    [undefined, null],
    ["", null],
    ["n/a", null],
    ["0", null],
    ["yesterday-ish", null],
  ])("showTimestamp(%j) = %j", (v, out) => {
    expect(showTimestamp(v)).toBe(out);
  });

  it("reads older systemd timestamps as server-local time", () => {
    expect(showTimestamp("Fri 2026-09-25 17:32:54 CDT")).toBe(new Date(2026, 8, 25, 17, 32, 54).getTime());
    expect(showTimestamp("Tue 2026-12-01 03:04:05 UTC")).toBe(new Date(2026, 11, 1, 3, 4, 5).getTime());
  });

  it("splits lists on any whitespace", () => {
    expect(showList("a.target  b.target\tc.target")).toEqual(["a.target", "b.target", "c.target"]);
    expect(showList(" sysinit.target\n")).toEqual(["sysinit.target"]);
    expect(showList(undefined)).toEqual([]);
    expect(showList("")).toEqual([]);
  });
});
