import { describe, expect, it } from "vitest";
import { ingress, MARK, plan, wanted, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";

const route = (host: string, extra: Partial<PlanRoute> = {}): PlanRoute => ({ host, name: host.split(".")[0]!, enabled: true, web: true, direct: false, ...extra });
const input = (extra: Partial<PlanInput> = {}): PlanInput => ({
  zone: "example.com",
  baseDomain: "example.com",
  routes: [],
  ipv4: "203.0.113.7",
  ipv6: null,
  tunnelHost: null,
  ...extra,
});
let n = 0;
const rec = (name: string, type: ExistingRecord["type"], content: string, proxied: boolean, comment: string | null = MARK): ExistingRecord => ({ id: `r${++n}`, name, type, content, proxied, comment });
const TUN = "1111-2222.cfargotunnel.com";

describe("wanted", () => {
  it("points the base domain through Cloudflare and the wildcard straight at the network", () => {
    const { wants } = wanted(input({ routes: [route("photos.example.com")] }));
    expect(wants).toEqual([
      { name: "example.com", why: "Base domain", records: [{ type: "A", content: "203.0.113.7", proxied: true }] },
      { name: "*.example.com", why: "Every name under example.com", records: [{ type: "A", content: "203.0.113.7", proxied: false }] },
    ]);
  });

  it("gives deeper names, names elsewhere in the zone and IPv6 their own records, and skips other zones and switched-off addresses", () => {
    const { wants } = wanted(
      input({
        baseDomain: "home.example.com",
        ipv6: "2001:db8::7",
        routes: [route("a.b.home.example.com"), route("blog.example.com"), route("other.net"), route("off.example.com", { enabled: false })],
      }),
    );
    expect(wants.map((w) => w.name)).toEqual(["home.example.com", "*.home.example.com", "a.b.home.example.com", "blog.example.com"]);
    expect(wants[2]!.records).toEqual([
      { type: "A", content: "203.0.113.7", proxied: false },
      { type: "AAAA", content: "2001:db8::7", proxied: false },
    ]);
  });

  it("sends web names to the tunnel and keeps chat, voice and direct addresses on A records", () => {
    const { wants } = wanted(
      input({
        tunnelHost: TUN,
        routes: [route("photos.example.com"), route("chat.example.com", { web: false }), route("tv.example.com", { direct: true }), route("x.y.example.com")],
      }),
    );
    const byName = Object.fromEntries(wants.map((w) => [w.name, w.records]));
    expect(byName["example.com"]).toEqual([{ type: "CNAME", content: TUN, proxied: true }]);
    expect(byName["*.example.com"]).toEqual([{ type: "CNAME", content: TUN, proxied: true }]);
    expect(byName["photos.example.com"]).toBeUndefined();
    expect(byName["chat.example.com"]).toEqual([{ type: "A", content: "203.0.113.7", proxied: false }]);
    expect(byName["tv.example.com"]).toEqual([{ type: "A", content: "203.0.113.7", proxied: false }]);
    expect(byName["x.y.example.com"]).toEqual([{ type: "CNAME", content: TUN, proxied: true }]);
  });

  it("without an internet address, still routes the tunnel and says why the rest was left alone", () => {
    const { wants, problems } = wanted(input({ ipv4: null, tunnelHost: TUN, routes: [route("chat.example.com", { web: false })] }));
    expect(wants.map((w) => w.name)).toEqual(["example.com", "*.example.com"]);
    expect(problems).toHaveLength(1);
  });
});

describe("plan", () => {
  it("creates what's missing, fixes its own stale records and leaves everything else in the zone alone", () => {
    const p = plan(input({ routes: [route("a.b.example.com")] }), [
      rec("example.com", "A", "198.51.100.1", true),
      rec("example.com", "MX", "mail.example.com", false, null),
      rec("mail.example.com", "A", "192.0.2.9", false, null),
    ]);
    expect(p.names.map((x) => [x.name, x.state])).toEqual([
      ["example.com", "change"],
      ["*.example.com", "change"],
      ["a.b.example.com", "change"],
    ]);
    expect(p.actions.map((a) => `${a.op} ${a.name} ${a.record.content}`)).toEqual([
      "update example.com 203.0.113.7",
      "create *.example.com 203.0.113.7",
      "create a.b.example.com 203.0.113.7",
    ]);
  });

  it("won't touch a name held by records it didn't make, until that name is handed over", () => {
    const existing = [rec("example.com", "A", "198.51.100.1", true, null), rec("*.example.com", "A", "203.0.113.7", false, "set by hand")];
    const before = plan(input(), existing);
    expect(before.names.map((x) => x.state)).toEqual(["conflict", "ok"]);
    expect(before.actions).toEqual([]);
    const after = plan(input(), existing, ["example.com"]);
    expect(after.actions).toEqual([{ op: "update", name: "example.com", id: existing[0]!.id, record: { type: "A", content: "203.0.113.7", proxied: true } }]);
  });

  it("moving to the tunnel deletes the A and AAAA records before it adds the CNAME", () => {
    const existing = [rec("example.com", "A", "203.0.113.7", true), rec("example.com", "AAAA", "2001:db8::7", true), rec("*.example.com", "A", "203.0.113.7", false)];
    const p = plan(input({ tunnelHost: TUN }), existing);
    expect(p.actions.map((a) => `${a.op} ${a.name} ${a.record.type}`)).toEqual([
      "delete example.com A",
      "delete example.com AAAA",
      "delete *.example.com A",
      "create example.com CNAME",
      "create *.example.com CNAME",
    ]);
  });

  it("removes its own record when an address is unpublished, but not a hand-made one at a name it never wanted", () => {
    const p = plan(input(), [
      rec("example.com", "A", "203.0.113.7", true),
      rec("*.example.com", "A", "203.0.113.7", false),
      rec("old.deep.example.com", "A", "203.0.113.7", false),
      rec("keep.deep.example.com", "A", "203.0.113.7", false, null),
    ]);
    expect(p.actions).toEqual([{ op: "delete", name: "old.deep.example.com", id: expect.any(String), record: { type: "A", content: "203.0.113.7", proxied: false } }]);
  });

  it("treats a trailing dot and capitals in Cloudflare's names as the same name", () => {
    const p = plan(input(), [rec("Example.COM.", "A", "203.0.113.7", true), rec("*.example.com", "A", "203.0.113.7", false)]);
    expect(p.actions).toEqual([]);
    expect(p.names.every((x) => x.state === "ok")).toBe(true);
  });
});

describe("ingress", () => {
  it("lists names the wildcard can't match first and always ends with a 404", () => {
    const rules = ingress({ zone: "example.com", baseDomain: "example.com", routes: [route("photos.example.com"), route("a.b.example.com"), route("tv.c.example.com", { direct: true }), route("chat.d.example.com", { web: false })] });
    expect(rules).toEqual([
      { hostname: "a.b.example.com", service: "http://localhost:80" },
      { hostname: "example.com", service: "http://localhost:80" },
      { hostname: "*.example.com", service: "http://localhost:80" },
      { service: "http_status:404" },
    ]);
  });
});
