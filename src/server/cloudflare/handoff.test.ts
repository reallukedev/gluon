import { describe, expect, it } from "vitest";
import type { CloudflareStatus, ManagedName } from "@/lib/cloudflare-types";
import type { DdnsStatus } from "@/lib/network-types";
import { handoff } from "./handoff";

const zones = [{ id: "z1", name: "example.com", accountId: "a", accountName: "Home" }];
const ddns = (config: Partial<DdnsStatus["config"]> = {}, extra: Partial<DdnsStatus> = {}): DdnsStatus => ({
  container: { exists: true, name: "cloudflare-ddns", state: "running", running: true, startedAt: null, image: "favonia/cloudflare-ddns", version: null, project: "proxy" },
  config: { domains: ["mc.example.com", "*.mc.example.com", "example.com"], ip4Domains: [], ip6Domains: [], proxied: "is(example.com)", proxiedDomains: ["example.com"], unproxiedDomains: [], ip4Provider: null, ip6Provider: "cloudflare.trace", updateSchedule: null, deleteOnStop: false, ...config },
  ipv4: { address: "203.0.113.7", at: 0 },
  ipv6: null,
  lastCheckAt: 0,
  lastChange: null,
  errors: [],
  recent: [],
  summary: "",
  state: "ok",
  ...extra,
});
const A = (proxied = false) => ({ type: "A" as const, content: "203.0.113.7", proxied });
const AAAA = { type: "AAAA" as const, content: "2001:db8::7", proxied: false };
const name = (n: string, x: Partial<ManagedName> = {}): ManagedName => ({ name: n, why: "", zone: "example.com", want: [A()], have: [A()], state: "deferred", message: null, foreign: false, kept: false, ...x });
const sync = (names: ManagedName[], x: Partial<CloudflareStatus["sync"]> = {}): CloudflareStatus["sync"] => ({ at: 1, running: false, ok: true, ipv4: "203.0.113.7", ipv6: null, names, covered: [], readOnly: [], problems: [], ...x });

describe("handoff from cloudflare-ddns", () => {
  it("isn't safe while Gluon doesn't keep the Minecraft names, and takeover is what fixes it", () => {
    const h = handoff(ddns(), zones, sync([name("example.com", { state: "ok" })]));
    expect(h.safe).toBe(false);
    expect(h.canTakeOver).toBe(true);
    expect(h.names.filter((n) => n.reason).map((n) => `${n.name} ${n.reason}`)).toEqual(["mc.example.com not-kept", "*.mc.example.com not-kept"]);
  });

  it("is safe once every name is Gluon's, whether by its own record or a wildcard it keeps", () => {
    const h = handoff(ddns(), zones, sync([name("example.com", { state: "ok" }), name("mc.example.com"), name("*.mc.example.com")]));
    expect(h).toMatchObject({ safe: true, canTakeOver: false });
    const viaWildcard = handoff(ddns({ domains: ["a.mc.example.com"] }), zones, sync([], { covered: ["a.mc.example.com"] }));
    expect(viaWildcard.safe).toBe(true);
  });

  it("isn't safe while records Gluon wasn't handed are in the way, or Cloudflare refused it", () => {
    const h = handoff(ddns(), zones, sync([name("example.com", { state: "ok" }), name("mc.example.com", { foreign: true }), name("*.mc.example.com", { state: "error" })]));
    expect(h.names.map((n) => n.reason)).toEqual(["foreign", "error", null]);
    expect(h).toMatchObject({ safe: false, canTakeOver: true });
  });

  it("is never safe when stopping it deletes the records, or Gluon's own check is failing", () => {
    const all = [name("example.com"), name("mc.example.com"), name("*.mc.example.com")];
    expect(handoff(ddns({ deleteOnStop: true }), zones, sync(all))).toMatchObject({ safe: false, deleteOnStop: true, canTakeOver: false });
    expect(handoff(ddns(), zones, sync(all, { problems: ["The token was revoked."] }))).toMatchObject({ safe: false, blocked: "The token was revoked." });
    expect(handoff(ddns(), zones, sync([], { at: null })).safe).toBe(false);
    // Already stopped, DELETE_ON_STOP can't do anything any more.
    const stopped = ddns({ deleteOnStop: true }, { container: { ...ddns().container, running: false, state: "exited" } });
    expect(handoff(stopped, zones, sync(all)).safe).toBe(true);
  });

  it("can't take over a name in a domain the token can't see", () => {
    const h = handoff(ddns({ domains: ["play.other.net"] }), zones, sync([]));
    expect(h.names[0]).toMatchObject({ name: "play.other.net", reason: "outside" });
    expect(h).toMatchObject({ safe: false, canTakeOver: false });
  });

  it("isn't safe while Gluon would write something else there, and says what changes", () => {
    const h = handoff(ddns(), zones, sync([name("example.com"), name("mc.example.com", { have: [A(), AAAA] }), name("*.mc.example.com", { have: [A(true)] })]));
    expect(h.names.map((n) => n.reason)).toEqual(["differs", "differs", null]);
    expect(h).toMatchObject({ safe: false, ipv6Differs: true, canTakeOver: false });
  });

  it("isn't safe when the token can't change a domain Gluon only waits on", () => {
    const h = handoff(ddns(), zones, sync([name("example.com"), name("mc.example.com"), name("*.mc.example.com")], { readOnly: ["example.com"] }));
    expect(h.names.every((n) => n.reason === "read-only")).toBe(true);
    expect(h.safe).toBe(false);
  });
});
