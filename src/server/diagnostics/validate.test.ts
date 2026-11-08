import { describe, expect, it } from "vitest";
import { RESOLVERS, hostField, normalizeHost, portField, resolverAddress, resolverField } from "./validate";

const HOST_MSG = "Enter a hostname like example.com or an IP address like 192.168.1.1.";
const RESOLVER_MSG = "Pick a resolver from the list or enter its IP address.";
const label63 = "a".repeat(63);

describe("normalizeHost", () => {
  it.each([
    ["  example.com  ", "example.com"],
    ["[::1]", "::1"],
    ["192.168.1.1", "192.168.1.1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["::ffff:192.0.2.1", "::ffff:192.0.2.1"],
    ["Example.COM.", "example.com"],
    ["a_b.example.com", "a_b.example.com"],
    ["_dmarc.example.com", "_dmarc.example.com"],
    ["localhost", "localhost"],
    ["nas", "nas"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    [`${label63}.example.com`, `${label63}.example.com`],
    ["a-b-c.example.com", "a-b-c.example.com"],
  ])("%j -> %j", (input, out) => {
    expect(normalizeHost(input)).toBe(out);
  });

  it("accepts names up to 253 characters, with or without a trailing dot", () => {
    const name = [label63, label63, label63, "a".repeat(61)].join(".");
    expect(name).toHaveLength(253);
    expect(normalizeHost(name)).toBe(name);
    expect(normalizeHost(`${name.slice(2)}.`)).toBe(name.slice(2));
    expect(normalizeHost(`a${name}`)).toBeNull();
  });

  it.each([
    "",
    "   ",
    "-x.com",
    "-oProxyCommand=x",
    "--help",
    "a-.example.com",
    "-a.example.com",
    "a..b",
    ".example.com",
    "example.com..",
    `${"a".repeat(64)}.example.com`,
    "a b",
    "a;b",
    "a|b",
    "a&b",
    "$(id)",
    "`id`",
    "http://example.com",
    "example.com/x",
    "example.com:80",
    "user@example.com",
    "bücher.example",
    "[::1",
    "-1.1.1.1",
    "exa\nmple.com",
  ])("refuses %j", (input) => {
    expect(normalizeHost(input)).toBeNull();
  });

  it("never throws on non-strings", () => {
    for (const v of [undefined, null]) expect(normalizeHost(v as unknown as string)).toBeNull();
    for (const v of [42, {}, [], Symbol.iterator]) expect(() => normalizeHost(v as unknown as string)).not.toThrow();
  });
});

describe("hostField", () => {
  it("normalises valid input", () => {
    expect(hostField.safeParse("Example.com")).toMatchObject({ success: true, data: "example.com" });
    expect(hostField.safeParse(" [2001:DB8::5] ")).toMatchObject({ success: true, data: "2001:db8::5" });
  });

  it.each(["-x.com", "a;b", "http://example.com", ""])("explains why %j is refused", (v) => {
    const r = hostField.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe(HOST_MSG);
  });

  it("refuses long strings and non-strings", () => {
    expect(hostField.safeParse(`${"a.".repeat(128)}com`).success).toBe(false);
    expect(hostField.safeParse(`   ${"a".repeat(253)}   `).success).toBe(false);
    for (const v of [42, null, undefined, ["example.com"]]) expect(hostField.safeParse(v).success).toBe(false);
  });
});

describe("portField", () => {
  it.each<[unknown, number]>([
    ["8080", 8080],
    [443, 443],
    ["1", 1],
    ["65535", 65535],
  ])("coerces %j", (v, n) => {
    expect(portField.safeParse(v)).toMatchObject({ success: true, data: n });
  });

  it.each<[unknown, string]>([
    ["1.5", "Ports are whole numbers."],
    [22.2, "Ports are whole numbers."],
    [0, "Ports go from 1 to 65535."],
    [-1, "Ports go from 1 to 65535."],
    [65536, "Ports go from 1 to 65535."],
    ["70000", "Ports go from 1 to 65535."],
  ])("refuses %j", (v, msg) => {
    const r = portField.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe(msg);
  });

  it("refuses non-numbers", () => {
    expect(portField.safeParse("abc").success).toBe(false);
    expect(portField.safeParse("80; rm -rf /").success).toBe(false);
  });
});

describe("resolvers", () => {
  it("lists the named resolvers", () => {
    expect(RESOLVERS).toEqual({ system: null, cloudflare: "1.1.1.1", google: "8.8.8.8", quad9: "9.9.9.9" });
  });

  it.each<[unknown, string]>([
    [undefined, "system"],
    [" Cloudflare ", "cloudflare"],
    ["GOOGLE", "google"],
    ["quad9", "quad9"],
    ["system", "system"],
    ["192.168.1.53", "192.168.1.53"],
    ["2606:4700:4700::1111", "2606:4700:4700::1111"],
  ])("accepts %j as %j", (v, out) => {
    expect(resolverField.safeParse(v)).toMatchObject({ success: true, data: out });
  });

  it.each(["dns.example.com", "-x", "1.1.1.1; rm", "opendns", "999.1.1.1"])("refuses %j", (v) => {
    const r = resolverField.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe(RESOLVER_MSG);
  });

  it("refuses long input", () => {
    expect(resolverField.safeParse(`${"1".repeat(65)}`).success).toBe(false);
  });

  it.each<[string, string | null]>([
    ["system", null],
    ["cloudflare", "1.1.1.1"],
    ["google", "8.8.8.8"],
    ["quad9", "9.9.9.9"],
    ["192.168.1.53", "192.168.1.53"],
    ["2001:db8::53", "2001:db8::53"],
  ])("resolverAddress(%j) = %j", (choice, out) => {
    expect(resolverAddress(choice)).toBe(out);
  });
});
