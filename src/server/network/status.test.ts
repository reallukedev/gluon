import { describe, expect, test } from "vitest";
import { parseIfInet6 } from "./status";

describe("this server's IPv6 addresses for DNS", () => {
  test("keeps stable global ones and leaves out home-only, privacy, deprecated and container addresses", () => {
    const text = [
      "20010db8000000010000000000000035 02 40 00 80     eth0",
      "20010db80000000102a0c9fffe12d5b8 02 40 00 00     eth0",
      "20010db80000000158e1a2b3c4d5e6f7 02 40 00 01     eth0",
      "20010db800000001aaaabbbbccccdddd 02 40 00 a0     eth0",
      "fd12345678900001000000000000002a 02 40 00 80     eth0",
      "fe800000000000000211223344556677 02 40 20 80     eth0",
      "00000000000000000000000000000001 01 80 10 80       lo",
      "20010db8000000020000000000000001 05 40 00 80  docker0",
    ].join("\n");
    expect(parseIfInet6(text)).toEqual(["2001:db8:0:1::35", "2001:db8:0:1:2a0:c9ff:fe12:d5b8"]);
  });

  test("an empty or unreadable table gives no addresses", () => {
    expect(parseIfInet6("")).toEqual([]);
    expect(parseIfInet6("garbage line\n")).toEqual([]);
  });
});
