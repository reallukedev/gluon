import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cellText, parseUptime, readBroadband, readDevices, readFirewall, readOptical, readSysinfo, readWifi, routerOffset, routerTime, sortDevices } from "./bgw-status";

// Anonymised copies of a real BGW320-500 (firmware 6.35.8): names, MACs, serials, public
// addresses and nonces replaced, markup untouched (open tags and all).
const f = (n: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", n), "latin1");
// When the pages were saved: the router's clock said 15:31:12, five hours behind UTC.
const SAVED = Date.parse("2026-10-25T20:31:12Z");
const me = { mac: "14:b3:1f:76:a7:5f", ip: "192.168.1.230" };

describe("System Information", () => {
  it("reads the router's facts, and when it started from its uptime in seconds", () => {
    const s = readSysinfo(f("sysinfo.html"), SAVED);
    expect([s.manufacturer, s.model, s.serial, s.firmware, s.hardware, s.wanMac]).toEqual(["HUMAX", "BGW320-500", "D90LG0TF123456", "6.35.8", "02001F00460050", "28:25:5f:a5:8a:f5"]);
    expect(s.uptimeS).toBe(518_420);
    expect(s.bootAt).toBe(SAVED - 518_420_000);
    expect(s.offset).toBe(-5 * 3_600_000);
    expect(s.firstUse).toBe(Date.parse("2026-05-11T18:06:16Z"));
  });

  it("takes uptime as seconds or days:hours:minutes:seconds, as its help text describes", () => {
    expect(parseUptime("518420")).toBe(518_420);
    expect(parseUptime("6:00:00:20")).toBe(6 * 86_400 + 20);
    expect(parseUptime("")).toBeNull();
  });

  it("turns the router's zoneless local times into instants, and leaves them alone when its clock is blank", () => {
    const off = routerOffset("2026-10-25T15:31:12", SAVED + 900);
    expect(off).toBe(-5 * 3_600_000);
    expect(routerTime("Sun Oct 25 15:31:12 2026", off)).toBe(SAVED);
    expect(routerTime("Sun Sep  6 23:32:40 2026", off)).toBe(Date.parse("2026-09-07T04:32:40Z"));
    expect(routerOffset("", SAVED)).toBeNull();
    expect(routerTime("Sun Oct 25 15:31:12 2026", null)).toBeNull();
  });
});

describe("Broadband and fiber", () => {
  it("reads the connection, both address families and the counters, keeping same-named rows in their sections", () => {
    const b = readBroadband(f("broadbandstatistics.html"));
    expect([b.source, b.up, b.ipv4, b.gateway4, b.mtu, b.lineMbps, b.pon]).toEqual(["Fiber", true, "203.0.113.42", "203.0.113.1", 1500, 10_000, "OPERATION (O5)"]);
    // "Primary DNS" appears again, empty, under IPv6: the IPv4 one wins.
    expect(b.dns).toEqual(["68.94.156.11", "68.94.157.11"]);
    expect(b.ipv6).toEqual({ available: true, kind: "native IPv6", address: "2001:db8:70a4:889e::1", gateway: "fe80::8626:2bff:fe00:1" });
    expect([b.rxBytes, b.txBytes, b.errors]).toEqual([648_788_033_747, 54_249_457_288, 0]);
  });

  it("reads light levels in dBm (the page gives tenths) against the router's own thresholds", () => {
    const o = readOptical(f("fiberstat.html"));
    expect([o.up, o.rxDbm, o.txDbm, o.temperatureC, o.module]).toEqual([true, -17.9, 6.1, 45, "Gemtek XGSPON-OMD8-CW"]);
    expect(o.rxWarn).toEqual({ low: -28.5, high: -7 });
    expect(o.rxAlarm).toEqual({ low: -30, high: -5 });
    expect(o.verdict).toBe("good");
    const weak = readOptical(f("fiberstat.html").replace("Rx Power&nbsp;&nbsp;Currently -179", "Rx Power&nbsp;&nbsp;Currently -290"));
    expect(weak.verdict).toBe("weak");
  });

  it("reads the firewall summary", () => {
    expect(readFirewall(f("firewall.html"))).toEqual({ packetFilter: true, ipPassthrough: false, natDefaultServer: false, advanced: true });
  });
});

describe("Wi-Fi", () => {
  it("lists each network with its band, home or guest, on or off and security", () => {
    expect(readWifi(f("home.html"))).toEqual([
      { band: "2.4 GHz", radioOn: true, ssid: "Maple IoT", kind: "home", on: true, security: "WPA-2" },
      { band: "2.4 GHz", radioOn: true, ssid: "ATTq7Zk2Wd_Guest", kind: "guest", on: false, security: null },
      { band: "5 GHz", radioOn: true, ssid: "Maple Home", kind: "home", on: true, security: "WPA-2" },
    ]);
  });
});

describe("Device List", () => {
  const off = readSysinfo(f("sysinfo.html"), SAVED).offset;
  const list = readDevices(f("devices.html"), f("home.html"), off, me);
  const byMac = (m: string) => list.find((d) => d.mac === m)!;

  it("reads every device, adding the ones only the Status page lists", () => {
    expect(list.filter((d) => d.mac)).toHaveLength(145);
    expect(list.filter((d) => !d.mac).map((d) => [d.ipv4, d.name, d.online])).toEqual([
      ["192.168.1.206", "drews-MacBook-Pro", false],
      ["192.168.1.230", "homeserver", true],
    ]);
    expect(list.filter((d) => d.online)).toHaveLength(32);
  });

  it("reads an online Wi-Fi device: address, IPv6 list, band, network, signal bars and last activity", () => {
    const d = byMac("a2:30:92:c6:77:57");
    expect([d.name, d.ipv4, d.online, d.kind, d.band, d.network, d.bars, d.allocation, d.guest]).toEqual(["Kitchen-Mac", "192.168.1.241", true, "wifi", "5 GHz", "Maple Home", 4, "dhcp", false]);
    expect(d.ipv6).toHaveLength(4);
    expect(d.ipv6[0]).toMatch(/^2001:db8:4b1:5a10:/);
    expect(d.lastActivity).toBe(Date.parse("2026-10-25T20:32:34Z"));
  });

  it("reads an offline wired device with no address, its port and speed, and no signal", () => {
    const d = byMac("14:b3:1f:76:a7:5f");
    expect([d.name, d.ipv4, d.online, d.kind, d.port, d.linkMbps, d.allocation, d.bars]).toEqual(["unknown14b31f76a75f", null, false, "ethernet", "LAN-1", 1000, "pending", null]);
    // "Mbps duplex" with no number is no speed at all.
    expect(list.find((d) => d.kind === "ethernet" && d.port === "LAN-2")!.linkMbps).toBeNull();
  });

  it("marks this server by MAC or address, never by a name other devices can share", () => {
    expect(list.filter((d) => d.server).map((d) => d.id)).toEqual(["14:b3:1f:76:a7:5f", "ip:192.168.1.230"]);
    // The sandbox Mac is "Kitchen-Mac" eight times over (a new private MAC per network join).
    const mac = readDevices(f("devices.html"), f("home.html"), off, { mac: "a2:30:92:c6:77:57", ip: "192.168.1.241" });
    expect(mac.filter((d) => d.server).map((d) => d.ipv4)).toEqual(["192.168.1.241"]);
    expect(mac.filter((d) => d.name === "Kitchen-Mac").length).toBeGreaterThan(1);
  });

  it("counts devices that share a name", () => {
    const watches = list.filter((d) => d.name === "Watch");
    expect(watches.length).toBeGreaterThan(5);
    expect(watches.every((d) => d.twins === watches.length - 1)).toBe(true);
  });

  it("sorts online first, this server first among them, then by last activity", () => {
    const sorted = sortDevices(list);
    expect(sorted[0]!.name).toBe("homeserver");
    const firstOffline = sorted.findIndex((d) => !d.online);
    expect(firstOffline).toBe(32);
    expect(sorted.slice(firstOffline).every((d) => !d.online)).toBe(true);
    expect(sorted[firstOffline]!.server).toBe(true);
  });
});

it("reads cell text the way the pages write it: <br>, image alt text and entities", () => {
  expect(cellText('<pre class="column">Wi-Fi <img src="/x.png" alt="Wi-Fi 4 bars" />&nbsp; <br />5 GHz Radio-1<br />Name: Maple Home\n</pre>')).toBe("Wi-Fi [Wi-Fi 4 bars]\n5 GHz Radio-1\nName: Maple Home");
  expect(cellText("AT&amp;T &#0187;")).toBe("AT&T »");
});
