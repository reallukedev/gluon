import { describe, expect, it } from "vitest";
import { fullName, RecordError, shortName, toBody } from "./records";
import type { DnsRecordInput } from "@/lib/cloudflare-types";

const r = (o: Partial<DnsRecordInput>): DnsRecordInput => ({ type: "A", name: "@", content: "203.0.113.7", proxied: false, ttl: 1, ...o });
const fails = (o: Partial<DnsRecordInput>, field: string) => {
  try {
    toBody(r(o), "leech.party");
  } catch (e) {
    expect(e).toBeInstanceOf(RecordError);
    expect((e as RecordError).field).toBe(field);
    return;
  }
  throw new Error("expected it to fail");
};

describe("names", () => {
  it("reads @, a short name or a full name the same way, and back", () => {
    expect(["@", "", "leech.party", "LEECH.party."].map((n) => fullName(n, "leech.party"))).toEqual(Array(4).fill("leech.party"));
    expect(fullName("media", "leech.party")).toBe("media.leech.party");
    expect(fullName("media.leech.party", "leech.party")).toBe("media.leech.party");
    expect(shortName("media.leech.party", "leech.party")).toBe("media");
    expect(shortName("leech.party", "leech.party")).toBe("@");
  });

  it("allows wildcards and underscore names (DKIM, SRV-style) and rejects spaces or stray dots", () => {
    expect(toBody(r({ name: "*" }), "leech.party").name).toBe("*.leech.party");
    expect(toBody(r({ type: "TXT", name: "s1._domainkey", content: "v=DKIM1; k=rsa" }), "leech.party").name).toBe("s1._domainkey.leech.party");
    fails({ name: "my site" }, "name");
    fails({ name: "a..b" }, "name");
  });
});

describe("content", () => {
  it("checks each type's value", () => {
    fails({ content: "300.1.1.1" }, "content");
    fails({ type: "AAAA", content: "2001:db8::7::1" }, "content");
    expect(toBody(r({ type: "AAAA", content: "2001:DB8::7" }), "leech.party").content).toBe("2001:db8::7");
    fails({ type: "CNAME", name: "www", content: "www.leech.party" }, "content");
    fails({ type: "MX", content: "not a host" }, "content");
    fails({ type: "TXT", content: "   " }, "content");
  });

  it("only proxies what Cloudflare can, and a proxied record's TTL is always automatic", () => {
    expect(toBody(r({ proxied: true, ttl: 300 }), "leech.party")).toMatchObject({ proxied: true, ttl: 1 });
    expect(toBody(r({ type: "TXT", content: "hello", proxied: true, ttl: 300 }), "leech.party")).toMatchObject({ proxied: false, ttl: 300 });
  });

  it("gives MX a priority, defaulting to 10, and refuses one out of range", () => {
    expect(toBody(r({ type: "MX", content: "mx.mail.example" }), "leech.party").priority).toBe(10);
    fails({ type: "MX", content: "mx.mail.example", priority: 70000 }, "priority");
  });

  it("won't let a hand-made record wear the note Gluon uses for its own", () => {
    fails({ comment: "Managed by Gluon" }, "comment");
    fails({ ttl: 42 }, "ttl");
  });
});
