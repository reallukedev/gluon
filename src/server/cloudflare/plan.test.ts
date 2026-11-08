import { describe, expect, it } from "vitest";
import { MARK, plan, wanted, type ExistingRecord, type PlanInput, type PlanRoute } from "./plan";

const route = (host: string, extra: Partial<PlanRoute> = {}): PlanRoute => ({ host, name: host.split(".")[0]!, enabled: true, web: true, direct: false, ...extra });
const input = (extra: Partial<PlanInput> = {}): PlanInput => ({
  zone: "example.com",
  baseDomain: "example.com",
  routes: [],
  ipv4: "203.0.113.7",
  ipv6: null,
  proxy: true,
  ...extra,
});
let n = 0;
const rec = (name: string, type: string, content: string, proxied: boolean, comment: string | null = MARK): ExistingRecord => ({ id: `r${++n}`, name, type, content, proxied, comment });
const A = (proxied: boolean) => ({ type: "A", content: "203.0.113.7", proxied });

describe("wanted", () => {
  it("proxies the base domain and the wildcard, and gives chat and direct addresses their own unproxied records", () => {
    const { wants } = wanted(input({ routes: [route("photos.example.com"), route("chat.example.com", { web: false }), route("tv.example.com", { direct: true })] }));
    expect(Object.fromEntries(wants.map((w) => [w.name, w.records]))).toEqual({
      "example.com": [A(true)],
      "*.example.com": [A(true)],
      "chat.example.com": [A(false)],
      "tv.example.com": [A(false)],
    });
  });

  it("with the proxy off, the wildcard covers chat and direct names and nothing else needs a record", () => {
    const { wants } = wanted(input({ proxy: false, routes: [route("photos.example.com"), route("chat.example.com", { web: false })] }));
    expect(Object.fromEntries(wants.map((w) => [w.name, w.records]))).toEqual({ "example.com": [A(true)], "*.example.com": [A(false)] });
  });

  it("never proxies a name Cloudflare's free certificate doesn't cover", () => {
    const { wants } = wanted(input({ baseDomain: "home.example.com", ipv6: "2001:db8::7", routes: [route("a.b.example.com"), route("blog.example.com"), route("other.net")] }));
    const byName = Object.fromEntries(wants.map((w) => [w.name, w.records.map((r) => `${r.type}:${r.proxied}`)]));
    expect(byName).toEqual({
      "home.example.com": ["A:true", "AAAA:true"],
      "*.home.example.com": ["A:false", "AAAA:false"],
      "a.b.example.com": ["A:false", "AAAA:false"],
      "blog.example.com": ["A:true", "AAAA:true"],
    });
  });
});

describe("another domain on the same token", () => {
  it("gives a name its own proxied record, with no base domain or wildcard written there", () => {
    const { wants } = wanted(input({ zone: "leech.party", baseDomain: "", routes: [route("media.leech.party"), route("leech.party"), route("chat.leech.party", { web: false })] }));
    expect(Object.fromEntries(wants.map((w) => [w.name, w.records]))).toEqual({
      "media.leech.party": [A(true)],
      "leech.party": [A(true)],
      "chat.leech.party": [A(false)],
    });
  });
});

describe("plan", () => {
  it("creates what's missing, fixes its own stale records and leaves everything else in the zone alone", () => {
    const p = plan(input({ routes: [route("a.b.example.com")] }), [
      rec("example.com", "A", "198.51.100.1", true),
      rec("example.com", "MX", "mail.example.com", false, null),
      rec("mail.example.com", "A", "192.0.2.9", false, null),
    ]);
    expect(p.actions.map((a) => `${a.op} ${a.name} ${a.record.content} ${a.record.proxied}`)).toEqual([
      "update example.com 203.0.113.7 true",
      "create *.example.com 203.0.113.7 true",
      "create a.b.example.com 203.0.113.7 false",
    ]);
  });

  it("won't touch a name held by records it didn't make, until that name is handed over", () => {
    const existing = [rec("example.com", "A", "198.51.100.1", true, null), rec("*.example.com", "A", "203.0.113.7", true, "set by hand")];
    const before = plan(input(), existing);
    expect(before.names.map((x) => x.state)).toEqual(["conflict", "ok"]);
    expect(before.actions).toEqual([]);
    const after = plan(input(), existing, ["example.com"]);
    expect(after.actions).toEqual([{ op: "update", name: "example.com", id: existing[0]!.id, record: A(true) }]);
  });

  it("without an internet address it deletes nothing, not even its own records", () => {
    const existing = [rec("example.com", "A", "203.0.113.7", true), rec("*.example.com", "A", "203.0.113.7", true), rec("tv.example.com", "A", "203.0.113.7", false), rec("gone.deep.example.com", "A", "203.0.113.7", false)];
    const p = plan(input({ ipv4: null, routes: [route("tv.example.com", { direct: true })] }), existing);
    expect(p.actions).toEqual([]);
    expect(p.problems).toHaveLength(1);
  });

  it("replaces a CNAME with an A record, deleting first so Cloudflare accepts it", () => {
    const p = plan(input(), [rec("example.com", "CNAME", "old.example.net", true), rec("*.example.com", "A", "203.0.113.7", true)]);
    expect(p.actions.map((a) => `${a.op} ${a.record.type}`)).toEqual(["delete CNAME", "create A"]);
  });

  it("removes its own record when an address is unpublished, but not a hand-made one at a name it never wanted", () => {
    const p = plan(input(), [
      rec("example.com", "A", "203.0.113.7", true),
      rec("*.example.com", "A", "203.0.113.7", true),
      rec("old.deep.example.com", "A", "203.0.113.7", false),
      rec("keep.deep.example.com", "A", "203.0.113.7", false, null),
    ]);
    expect(p.actions).toEqual([{ op: "delete", name: "old.deep.example.com", id: expect.any(String), record: A(false) }]);
  });

  it("doesn't let someone else's record at a name the wildcard covers go unseen, since it beats the wildcard", () => {
    const base = [rec("example.com", "A", "203.0.113.7", true), rec("*.example.com", "A", "203.0.113.7", true)];
    const stale = rec("photos.example.com", "A", "198.51.100.1", false, null);
    const p = plan(input({ routes: [route("photos.example.com")] }), [...base, stale]);
    expect(p.names.find((x) => x.name === "photos.example.com")).toMatchObject({ state: "conflict", want: [A(true)] });
    expect(p.actions).toEqual([]);
    // Handed over, it's brought in line with the wildcard; Gluon's own leftover there is just removed.
    expect(plan(input({ routes: [route("photos.example.com")] }), [...base, stale], ["photos.example.com"]).actions).toEqual([{ op: "update", name: "photos.example.com", id: stale.id, record: A(true) }]);
    const mine = rec("photos.example.com", "A", "203.0.113.7", true);
    expect(plan(input({ routes: [route("photos.example.com")] }), [...base, mine]).actions).toEqual([{ op: "delete", name: "photos.example.com", id: mine.id, record: A(true) }]);
  });

  it("treats a trailing dot and capitals in Cloudflare's names as the same name", () => {
    const p = plan(input(), [rec("Example.COM.", "A", "203.0.113.7", true), rec("*.example.com", "A", "203.0.113.7", true)]);
    expect(p.actions).toEqual([]);
  });
});
