import { describe, expect, test } from "vitest";
import { publicIpv4From } from "./probes";

describe("reading this network's public address from a lookup service", () => {
  test("takes the ip= line of a trace, or a bare address", () => {
    expect(publicIpv4From("fl=123\nh=1.1.1.1\nip=203.0.113.7\nts=1\n")).toBe("203.0.113.7");
    expect(publicIpv4From("198.51.100.20\n")).toBe("198.51.100.20");
  });

  test("refuses anything that can't be an address on the internet, so DNS is never pointed at it", () => {
    for (const body of ["ip=192.168.1.1", "ip=10.0.0.5", "ip=100.64.3.2", "ip=127.0.0.1", "ip=169.254.1.1", "ip=0.0.0.0", "ip=224.0.0.1", "ip=1.2.3", "ip=2001:db8::1", "ip=999.1.1.1", "<html>blocked</html>", ""]) {
      expect(publicIpv4From(body)).toBeNull();
    }
  });
});
