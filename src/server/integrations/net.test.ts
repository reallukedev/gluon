import { describe, expect, test, vi } from "vitest";

// The home's ranges come from settings (declared by the admin) and the host's own IPv6 /64 (from /proc).
vi.mock("../settings", () => ({
  getSetting: (key: string) => (key === "homeNetworks" ? ["203.0.113.0/24", "2001:db8:aaaa::/48"] : undefined),
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const line = "2a02810912345678000000000000a1b2 02 40 00 80     eth0\n00000000000000000000000000000001 01 80 10 80       lo\n";
  const readFileSync = ((p: unknown, ...rest: unknown[]) =>
    typeof p === "string" && p.endsWith("/net/if_inet6") ? line : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const { addressProblem } = await import("./net");

describe("members' personal URLs can't reach the home network", () => {
  test.each([
    ["192.168.1.230", "RFC 1918"],
    ["203.0.113.7", "a range the admin declared as home"],
    ["2001:db8:aaaa:1::1", "a declared IPv6 range"],
    ["2a02:8109:1234:5678::99", "the host's own IPv6 /64"],
    ["[2a02:8109:1234:5678:abcd::1]", "the host's /64, bracketed"],
  ])("%s (%s) is refused", (addr) => {
    expect(addressProblem(addr, "member")).toMatch(/inside the home network/);
  });

  test.each([["8.8.8.8"], ["2606:4700::1111"], ["2a02:8109:1234:5679::1"]])("%s on the internet is fine", (addr) => {
    expect(addressProblem(addr, "member")).toBeNull();
  });

  test("admins' and connections' addresses may be at home", () => {
    expect(addressProblem("203.0.113.7", "trusted")).toBeNull();
    expect(addressProblem("2a02:8109:1234:5678::99", "trusted")).toBeNull();
  });
});
