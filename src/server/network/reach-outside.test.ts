import { describe, expect, test, vi } from "vitest";
import { confirmFromOutside, targetKey, type OutsideCache, type PortChecker, type ReachTarget } from "./reach-outside";
import type { ReachOutcome } from "@/lib/network-types";

const IP = "203.0.113.7";
const c2s: ReachTarget = { kind: "xmpp-client", port: 5222, domain: "chat.example.com", lanFingerprint: "aa" };
const s2s: ReachTarget = { kind: "xmpp-server", port: 5269, domain: "chat.example.com", lanFingerprint: "aa" };
const direct: ReachTarget = { kind: "tls", port: 5223, domain: "chat.example.com", lanFingerprint: "aa" };
const mumble: ReachTarget = { kind: "tcp", port: 64738 };
const udp: ReachTarget = { kind: "mumble-udp", port: 64738, lan: { reachable: true, ms: 1, version: "1.5", users: 0, maxUsers: 10 } };

const loop = (...xs: [ReachTarget, ReachOutcome][]) => new Map(xs.map(([t, o]) => [targetKey(t), o]));
const answering = (open: Record<number, boolean>) => vi.fn<PortChecker>(async (_ip, ports) => new Map(ports.filter((p) => p in open).map((p) => [p, open[p]!])));
const run = (targets: ReachTarget[], loopback: Map<string, ReachOutcome>, checker: PortChecker, cache: OutsideCache = new Map(), force = false, now = () => 1_000_000) =>
  confirmFromOutside(IP, targets, loopback, { checker, cache, force, now });

describe("checking ports from the internet when they don't answer through the router", () => {
  test("a port closed through the router but open from outside reaches this server", async () => {
    const r = await run([c2s], loop([c2s, "none"]), answering({ 5222: true }));
    expect(r.get(targetKey(c2s))).toBe("same");
  });

  test("a port closed from outside too stays closed", async () => {
    const r = await run([c2s], loop([c2s, "none"]), answering({ 5222: false }));
    expect(r.get(targetKey(c2s))).toBe("none");
  });

  test("a failed outside check leaves the port unconfirmed", async () => {
    const failing = vi.fn<PortChecker>(async () => {
      throw new Error("timed out");
    });
    const r = await run([c2s, s2s], loop([c2s, "none"], [s2s, "none"]), failing);
    expect([r.get(targetKey(c2s)), r.get(targetKey(s2s))]).toEqual(["unconfirmed", "unconfirmed"]);
  });

  test("a port missing from the answer is unconfirmed", async () => {
    const r = await run([c2s, s2s], loop([c2s, "none"], [s2s, "none"]), answering({ 5222: true }));
    expect(r.get(targetKey(s2s))).toBe("unconfirmed");
  });

  test("UDP and ports that already answered aren't sent", async () => {
    const checker = answering({ 5269: true });
    const r = await run([udp, c2s, s2s], loop([udp, "none"], [c2s, "same"], [s2s, "none"]), checker);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker).toHaveBeenCalledWith(IP, [5269]);
    expect(r.get(targetKey(udp))).toBe("none");
    expect(r.get(targetKey(c2s))).toBe("same");
  });

  test("nothing is sent when every port answered or only UDP didn't", async () => {
    const checker = answering({});
    await run([udp, c2s], loop([udp, "none"], [c2s, "same"]), checker);
    expect(checker).not.toHaveBeenCalled();
  });

  test("all the closed TCP ports go in one request, each port once", async () => {
    const other: ReachTarget = { ...c2s, domain: "other.example.com" };
    const checker = answering({ 5222: true, 5223: true, 5269: false, 64738: true });
    const r = await run([c2s, other, s2s, direct, mumble], loop([c2s, "none"], [other, "none"], [s2s, "none"], [direct, "none"], [mumble, "none"]), checker);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker).toHaveBeenCalledWith(IP, [5222, 5223, 5269, 64738]);
    expect([c2s, other, s2s, direct, mumble].map((t) => r.get(targetKey(t)))).toEqual(["same", "same", "none", "same", "same"]);
  });

  test("answers are cached, and Check now asks again only after a minute", async () => {
    const cache: OutsideCache = new Map();
    const checker = answering({ 5222: true });
    let t = 1_000_000;
    const again = (force = false) => run([c2s], loop([c2s, "none"]), checker, cache, force, () => t);
    await again();
    t += 30_000;
    await again(true);
    expect(checker).toHaveBeenCalledTimes(1);
    t += 40_000;
    await again();
    expect(checker).toHaveBeenCalledTimes(1);
    await again(true);
    expect(checker).toHaveBeenCalledTimes(2);
    t += 5 * 60_000;
    await again();
    expect(checker).toHaveBeenCalledTimes(3);
  });

  test("failures are cached too, so a service that's down isn't asked on every refresh", async () => {
    const cache: OutsideCache = new Map();
    const failing = vi.fn<PortChecker>(async () => {
      throw new Error("down");
    });
    await run([c2s], loop([c2s, "none"]), failing, cache);
    const r = await run([c2s], loop([c2s, "none"]), failing, cache);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(r.get(targetKey(c2s))).toBe("unconfirmed");
  });
});
