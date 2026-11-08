import { describe, expect, it, vi } from "vitest";
import { compressIpv6, parseAddr, parseProcesses, parseSs, procNetSockets } from "./sockets";

describe("parseAddr", () => {
  it.each([
    ["0.0.0.0:2283", { ip: "0.0.0.0", port: 2283, iface: null }],
    ["[::]:2283", { ip: "::", port: 2283, iface: null }],
    ["*:8080", { ip: "0.0.0.0", port: 8080, iface: null }],
    ["*:*", { ip: "0.0.0.0", port: null, iface: null }],
    ["0.0.0.0:*", { ip: "0.0.0.0", port: null, iface: null }],
    ["[::ffff:172.17.0.1]:8581", { ip: "::ffff:172.17.0.1", port: 8581, iface: null }],
    ["192.168.1.10%enp4s0:68", { ip: "192.168.1.10", port: 68, iface: "enp4s0" }],
    ["[fe80::1]%enp4s0:546", { ip: "fe80::1", port: 546, iface: "enp4s0" }],
    ["[fe80::1%enp4s0]:546", { ip: "fe80::1", port: 546, iface: "enp4s0" }],
    ["127.0.0.53%lo:53", { ip: "127.0.0.53", port: 53, iface: "lo" }],
    ["10.0.0.5:http", { ip: "10.0.0.5", port: null, iface: null }],
  ])("%j", (s, out) => {
    expect(parseAddr(s)).toEqual(out);
  });

  it("never throws on junk", () => {
    for (const s of ["", ":", "[", "[]:", "%", "]]]:1", "garbage", "[::1", "::::::"]) {
      expect(() => parseAddr(s)).not.toThrow();
    }
  });
});

describe("parseProcesses", () => {
  it("returns nothing for an empty column", () => {
    expect(parseProcesses(undefined)).toEqual([]);
    expect(parseProcesses("")).toEqual([]);
  });

  it("keeps one entry per pid, in order", () => {
    expect(
      parseProcesses('users:(("docker-proxy",pid=3208,fd=8),("docker-proxy",pid=3208,fd=9),("nginx",pid=12,fd=3))'),
    ).toEqual([
      { name: "docker-proxy", pid: 3208 },
      { name: "nginx", pid: 12 },
    ]);
    expect(parseProcesses('users:(("nginx",pid=12,fd=3),("nginx",pid=13,fd=3),("nginx",pid=12,fd=4))')).toEqual([
      { name: "nginx", pid: 12 },
      { name: "nginx", pid: 13 },
    ]);
  });

  it("keeps quotes, commas and parentheses inside a name", () => {
    expect(parseProcesses('users:(("my \\"x\\" (1)",pid=7,fd=1))')).toEqual([{ name: 'my \\"x\\" (1)', pid: 7 }]);
    expect(parseProcesses('users:(("a,b)",pid=8,fd=1),("c",pid=9,fd=2))')).toEqual([
      { name: "a,b)", pid: 8 },
      { name: "c", pid: 9 },
    ]);
  });
});

describe("parseSs", () => {
  const SAMPLE = [
    'tcp   LISTEN 0      4096         0.0.0.0:2283       0.0.0.0:*    users:(("docker-proxy",pid=3208,fd=8),("docker-proxy",pid=3208,fd=9))',
    'udp   UNCONN 0      0      192.168.1.10%enp4s0:68         0.0.0.0:*    users:(("systemd-network",pid=611,fd=22))',
    'tcp   ESTAB  0      36           192.168.1.10:22    192.168.1.20:51234 users:(("sshd",pid=9001,fd=4))',
    "tcp   0      0            [::ffff:172.17.0.1]:8581  [::ffff:172.17.0.2]:40000",
  ];

  it("parses the sample", () => {
    expect(parseSs(SAMPLE.join("\n"))).toEqual([
      {
        proto: "tcp",
        state: "LISTEN",
        recvQ: 0,
        sendQ: 4096,
        local: { ip: "0.0.0.0", port: 2283, iface: null },
        peer: { ip: "0.0.0.0", port: null },
        processes: [{ name: "docker-proxy", pid: 3208 }],
      },
      {
        proto: "udp",
        state: "UNCONN",
        recvQ: 0,
        sendQ: 0,
        local: { ip: "192.168.1.10", port: 68, iface: "enp4s0" },
        peer: { ip: "0.0.0.0", port: null },
        processes: [{ name: "systemd-network", pid: 611 }],
      },
      {
        proto: "tcp",
        state: "ESTAB",
        recvQ: 0,
        sendQ: 36,
        local: { ip: "192.168.1.10", port: 22, iface: null },
        peer: { ip: "192.168.1.20", port: 51234 },
        processes: [{ name: "sshd", pid: 9001 }],
      },
      {
        proto: "tcp",
        state: null,
        recvQ: 0,
        sendQ: 0,
        local: { ip: "::ffff:172.17.0.1", port: 8581, iface: null },
        peer: { ip: "::ffff:172.17.0.2", port: 40000 },
        processes: [],
      },
    ]);
  });

  it("skips headers, other netids, portless and short lines, and tolerates CRLF", () => {
    const text = [
      "",
      "Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "icmp6 UNCONN 0      0      *:ipv6-icmp        *:*",
      "raw   UNCONN 0      0      *:icmp             *:*",
      "u_str LISTEN 0      4096   /run/docker.sock 12345 * 0",
      "nl    UNCONN 0      0      rtnl:kernel        *",
      "tcp   LISTEN 0      4096   [::]:*             [::]:*",
      "tcp   LISTEN 0",
      '  tcp   LISTEN x      y      [::]:443           [::]:*    users:(("caddy",pid=77,fd=9))   ',
      "",
    ].join("\r\n");
    expect(parseSs(text)).toEqual([
      {
        proto: "tcp",
        state: "LISTEN",
        recvQ: 0,
        sendQ: 0,
        local: { ip: "::", port: 443, iface: null },
        peer: { ip: "::", port: null },
        processes: [{ name: "caddy", pid: 77 }],
      },
    ]);
    expect(parseSs("")).toEqual([]);
  });
});

describe("compressIpv6", () => {
  it.each([
    [["2001", "0DB8", "0000", "0000", "0000", "0000", "0000", "0001"], "2001:db8::1"],
    [["2001", "db8", "0", "0", "1", "0", "0", "1"], "2001:db8::1:0:0:1"],
    [["2001", "db8", "0", "1", "1", "1", "1", "1"], "2001:db8:0:1:1:1:1:1"],
    [["0", "0", "0", "0", "0", "0", "0", "0"], "::"],
    [["0", "0", "0", "0", "0", "0", "0", "1"], "::1"],
    [["fe80", "0", "0", "0", "0", "0", "0", "0"], "fe80::"],
    [["2001", "db8", "0", "0", "1", "0", "0", "0"], "2001:db8:0:0:1::"],
    [["1", "0", "0", "2", "0", "0", "0", "3"], "1:0:0:2::3"],
    [["FE80", "0000", "0000", "0000", "0250", "56FF", "FE12", "3456"], "fe80::250:56ff:fe12:3456"],
  ])("%j -> %s", (groups, out) => {
    expect(compressIpv6(groups)).toBe(out);
  });
});

describe("procNetSockets", () => {
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const files: Record<string, string | null> = {
    "/proc/4242/net/tcp": [
      header,
      "   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000001 00:00000000 00000000   999        0 1",
      "   1: 0A01A8C0:0016 1401A8C0:C822 01 0000001F:00000000 02:000AE79D 00000000     0        0 2",
      "   2: short line",
    ].join("\n"),
    "/proc/4242/net/tcp6": [
      header,
      "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0a 00000000:00000000 00:00000000 00000000 0 0 3",
      "   1: B80D0120000000000000000001000000:01BB 000080FE00000000FF565002563412FE:D431 01 00000000:00000000 00:00000000 00000000 0 0 4",
      "   2: 0000000000000000FFFF00000100007F:1F90 0000000000000000FFFF00000A01A8C0:A000 06 00000000:00000000 00:00000000 00000000 0 0 5",
    ].join("\n"),
    "/proc/4242/net/udp": null,
    "/proc/4242/net/udp6": [
      header,
      "  10: 00000000000000000000000000000000:14E9 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000 0 0 6",
    ].join("\n"),
  };

  it("reads all four files in order and decodes kernel hex", () => {
    const readFile = vi.fn((p: string) => (p in files ? files[p] : "should not be read"));
    const out = procNetSockets(readFile, 4242);
    expect(readFile.mock.calls.map((c) => c[0]).sort()).toEqual(
      ["/proc/4242/net/tcp", "/proc/4242/net/tcp6", "/proc/4242/net/udp", "/proc/4242/net/udp6"].sort(),
    );
    expect(out).toEqual([
      {
        proto: "tcp",
        local: { ip: "127.0.0.1", port: 3306 },
        remote: { ip: "0.0.0.0", port: 0 },
        st: "0A",
        txQ: 0,
        rxQ: 1,
      },
      {
        proto: "tcp",
        local: { ip: "192.168.1.10", port: 22 },
        remote: { ip: "192.168.1.20", port: 51234 },
        st: "01",
        txQ: 31,
        rxQ: 0,
      },
      { proto: "tcp", local: { ip: "::1", port: 8080 }, remote: { ip: "::", port: 0 }, st: "0A", txQ: 0, rxQ: 0 },
      {
        proto: "tcp",
        local: { ip: "2001:db8::1", port: 443 },
        remote: { ip: "fe80::250:56ff:fe12:3456", port: 54321 },
        st: "01",
        txQ: 0,
        rxQ: 0,
      },
      {
        proto: "tcp",
        local: { ip: "::ffff:127.0.0.1", port: 8080 },
        remote: { ip: "::ffff:192.168.1.10", port: 40960 },
        st: "06",
        txQ: 0,
        rxQ: 0,
      },
      { proto: "udp", local: { ip: "::", port: 5353 }, remote: { ip: "::", port: 0 }, st: "07", txQ: 0, rxQ: 0 },
    ]);
  });

  it("returns nothing when every file is missing or empty", () => {
    expect(procNetSockets(() => null, 1)).toEqual([]);
    expect(procNetSockets(() => "", 1)).toEqual([]);
    expect(procNetSockets(() => header, 1)).toEqual([]);
  });
});
